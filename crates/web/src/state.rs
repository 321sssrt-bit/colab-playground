mod accounts;
mod forwards;
mod login;
pub mod plugins;
mod polling;
pub mod sessions;
mod shutdown;

use std::{
    collections::BTreeMap,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::Duration,
};

use colab_playground_core::{
    CancelToken, Error, ErrorKind, Result,
    accounts::{AccountId, AccountsView},
    backend::{
        AccountUsageView, Backend, BackendKind, Events, GuardReport, PluginRunEvent,
        PluginRunOutcome, PluginRunSpec, RuntimeRef, RuntimesView,
    },
    host::ProbeReport,
    plugins::ResolvedEndpoint,
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    tunnel::{TunnelId, TunnelInfo},
};
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Notify, watch},
    task::{JoinHandle, spawn_blocking},
};

pub use accounts::{AccountSwitchApproval, AccountSwitchPreview};
pub use forwards::ForwardPolicy;
pub use login::{CancelLoginOutcome, LoginPrompt, SubmitCancelOutcome, SubmitCancelSettlement};
pub use shutdown::{Billing, ShutdownReport};

const LOGIN_INACTIVITY: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountContext {
    pub revision: u64,
    pub active: Option<AccountId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Operation {
    Provision {
        session: String,
    },
    PluginRun {
        plugin: String,
        session: String,
    },
    SwitchAccount {
        to: AccountId,
    },
    Login {
        #[serde(skip_serializing_if = "Option::is_none")]
        login_id: Option<u64>,
    },
    Domain {
        name: &'static str,
        key: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingOperation {
    pub id: u64,
    pub operation: Operation,
    pub cancelling: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub version: u64,
    pub backend: BackendKind,
    pub account: AccountContext,
    pub accounts: Option<AccountsView>,
    pub accounts_error: Option<ErrorKind>,
    #[serde(skip)]
    recovered_pending_add_latched: bool,
    pub runtimes: Option<RuntimesView>,
    pub runtimes_error: Option<ErrorKind>,
    pub tunnels: Vec<TunnelInfo>,
    #[serde(skip)]
    forward_endpoints: BTreeMap<TunnelId, ResolvedEndpoint>,
    pub usage: Vec<AccountUsageView>,
    pub guard: Option<GuardReport>,
    pub guard_error: Option<ErrorKind>,
    pub operations: Vec<PendingOperation>,
    pub login_id: Option<u64>,
    pub shutting_down: bool,
}

#[derive(Debug, Clone)]
pub enum Access {
    Independent,
    Runtime,
    HostWrite,
    Account(AccountContext),
    AccountWrite(AccountContext),
}

#[derive(Clone)]
pub struct WebState(Arc<Inner>);

struct Inner {
    backend: Arc<dyn Backend>,
    control: Mutex<Control>,
    poll_slot: PollSlot,
    snapshots: watch::Sender<Arc<Snapshot>>,
    refresh: Notify,
    drained: Notify,
    login_inactivity: Duration,
    forward_policy: ForwardPolicy,
    forwards: Mutex<forwards::ForwardUpdates>,
    plugins: plugins::Plugins,
    provisions: sessions::Provisions,
}

#[derive(Default)]
struct PollSlot {
    locked: Mutex<bool>,
    changed: Condvar,
}

struct PollSlotGuard<'a>(&'a PollSlot);

impl Drop for PollSlotGuard<'_> {
    fn drop(&mut self) {
        let mut locked = self.0.locked.lock().unwrap_or_else(|e| e.into_inner());
        *locked = false;
        self.0.changed.notify_all();
    }
}

impl PollSlot {
    fn lock(&self) -> PollSlotGuard<'_> {
        let mut locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        while *locked {
            locked = self.changed.wait(locked).unwrap_or_else(|e| e.into_inner());
        }
        *locked = true;
        PollSlotGuard(self)
    }

    fn lock_cancellable(&self, cancel: &CancelToken) -> Result<PollSlotGuard<'_>> {
        let mut locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            cancel.check()?;
            if !*locked {
                *locked = true;
                return Ok(PollSlotGuard(self));
            }
            let (guard, _) = self
                .changed
                .wait_timeout(locked, Duration::from_millis(20))
                .unwrap_or_else(|e| e.into_inner());
            locked = guard;
        }
    }

    fn notify_waiters(&self) {
        let _locked = self.locked.lock().unwrap_or_else(|e| e.into_inner());
        self.changed.notify_all();
    }
}

#[derive(Default)]
struct Control {
    next_id: u64,
    running: BTreeMap<u64, Running>,
    login: Option<login::PendingLogin>,
    login_job: Option<login::ActiveLoginJob>,
    shutting_down: bool,
    uncertain_cleanup: bool,
}

struct Running {
    operation: Option<Operation>,
    cancel: CancelToken,
    access: Slot,
    allocating: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    Independent,
    Shared,
    Poll,
    Exclusive,
}

pub enum Submission<T> {
    Started { id: u64, job: JoinHandle<Result<T>> },
    AlreadyRunning { id: u64 },
}

struct Job {
    state: WebState,
    id: u64,
    cancel: CancelToken,
    finished: bool,
}

impl Job {
    fn finish_locked(&mut self, control: &mut Control) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.release_locked(control);
    }

    fn release_locked(&self, control: &mut Control) {
        let running = control.running.remove(&self.id).expect("reserved job");
        if control
            .login_job
            .as_ref()
            .is_some_and(|active| active.job_id == self.id)
        {
            control.login_job = None;
        }
        self.state.publish_operations(control);
        if running.operation.is_some() {
            self.state.0.refresh.notify_one();
        }
        self.state.0.drained.notify_waiters();
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut control = self.state.lock();
        self.release_locked(&mut control);
    }
}

impl WebState {
    pub async fn start(backend: Arc<dyn Backend>) -> Result<Self> {
        Self::start_with_forward_policy(backend, ForwardPolicy::default()).await
    }

    pub async fn start_with_forward_policy(
        backend: Arc<dyn Backend>,
        forward_policy: ForwardPolicy,
    ) -> Result<Self> {
        Self::start_with_timeout(backend, LOGIN_INACTIVITY, forward_policy).await
    }

    /// Starts the state with a custom OAuth prompt inactivity deadline.
    pub async fn start_with_timeout(
        backend: Arc<dyn Backend>,
        login_inactivity: Duration,
        forward_policy: ForwardPolicy,
    ) -> Result<Self> {
        let (backend, kind) = spawn_blocking(move || {
            let kind = backend.kind();
            (backend, kind)
        })
        .await
        .map_err(|_| Error::new(ErrorKind::Other))?;
        let (snapshots, _) = watch::channel(Arc::new(Snapshot {
            version: 1,
            backend: kind,
            account: AccountContext {
                revision: 0,
                active: None,
            },
            accounts: None,
            accounts_error: None,
            recovered_pending_add_latched: false,
            runtimes: None,
            runtimes_error: None,
            tunnels: Vec::new(),
            forward_endpoints: BTreeMap::new(),
            usage: Vec::new(),
            guard: None,
            guard_error: None,
            operations: Vec::new(),
            login_id: None,
            shutting_down: false,
        }));
        let state = Self(Arc::new(Inner {
            backend,
            control: Mutex::default(),
            poll_slot: PollSlot::default(),
            snapshots,
            refresh: Notify::new(),
            drained: Notify::new(),
            login_inactivity,
            forward_policy,
            forwards: Mutex::default(),
            plugins: plugins::Plugins::default(),
            provisions: Mutex::default(),
        }));
        tokio::spawn(state.clone().poll());
        tokio::spawn(state.clone().poll_forwards());
        Ok(state)
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.0.snapshots.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.0.snapshots.subscribe()
    }

    pub fn forward_policy(&self) -> ForwardPolicy {
        self.0.forward_policy
    }

    pub async fn run_backend<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn Backend, &CancelToken) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.backend_job(Slot::Independent, work).await
    }

    pub async fn probe_environment(&self) -> Result<(ProbeReport, Arc<Snapshot>)> {
        let state = self.clone();
        self.backend_job(Slot::Shared, move |backend, cancel| {
            let _poll = state.lock_poll_slot();
            cancel.check()?;
            let report = backend.probe(cancel)?;
            if report.colab.is_some() {
                state.refresh_overview(backend, cancel);
            } else {
                state.clear_overview();
            }
            Ok((report, state.snapshot()))
        })
        .await
    }

    async fn backend_job<T: Send + 'static>(
        &self,
        slot: Slot,
        work: impl FnOnce(&dyn Backend, &CancelToken) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let job = {
            let mut control = self.lock();
            if control.shutting_down {
                return Err(Error::cancelled());
            }
            if !control.available(slot) {
                return Err(Error::new(ErrorKind::Busy));
            }
            self.reserve(&mut control, None, slot, false)
        };
        spawn_blocking(move || {
            job.cancel.check()?;
            work(&*job.state.0.backend, &job.cancel)
        })
        .await
        .map_err(|_| Error::new(ErrorKind::Other))?
    }

    /// Domain adapters supply a stable, non-secret key. Dropping the handle leaves the job running.
    pub fn start_operation<T: Send + 'static>(
        &self,
        name: &'static str,
        key: String,
        access: Access,
        work: impl FnOnce(&dyn Backend, &CancelToken) -> Result<T> + Send + 'static,
    ) -> Result<Submission<T>> {
        self.start_job(
            Operation::Domain { name, key },
            access,
            false,
            move |_, backend, cancel| work(backend, cancel),
        )
    }

    pub fn provision(
        &self,
        account: AccountContext,
        spec: ProvisionSpec,
        events: Events<ProvisionEvent>,
    ) -> Result<Submission<ProvisionOutcome>> {
        spec.validate()?;
        let session = spec.name.clone();
        let active = required_account(&account)?;
        self.start_job(
            Operation::Provision {
                session: session.clone(),
            },
            Access::Account(account),
            true,
            move |_, backend, cancel| {
                run_allocation(backend, cancel, &active, &session, false, || {
                    backend.provision(spec, events, cancel)
                })
            },
        )
    }

    pub fn run_plugin(
        &self,
        account: AccountContext,
        spec: PluginRunSpec,
        existing: Option<RuntimeRef>,
        events: Events<PluginRunEvent>,
    ) -> Result<Submission<PluginRunOutcome>> {
        self.start_plugin_job(
            account,
            spec,
            existing,
            move |backend, spec, cancel| backend.run_plugin(spec, events, cancel),
            |_, _, outcome| Ok(outcome),
        )
    }

    pub fn cancel(&self, id: u64) -> bool {
        let cancelled = {
            let control = self.lock();
            let cancelled = control
                .running
                .get(&id)
                .is_some_and(|running| running.operation.is_some() && running.cancel.cancel());
            if cancelled {
                self.publish_operations(&control);
            }
            cancelled
        };
        if cancelled {
            self.0.poll_slot.notify_waiters();
        }
        cancelled
    }

    fn lock(&self) -> MutexGuard<'_, Control> {
        self.0
            .control
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn update(&self, change: impl FnOnce(&mut Snapshot) -> bool) {
        self.0.snapshots.send_if_modified(|snapshot| {
            let snapshot = Arc::make_mut(snapshot);
            if change(snapshot) {
                snapshot.version += 1;
                true
            } else {
                false
            }
        });
    }

    fn publish_operations(&self, control: &Control) {
        self.update(|snapshot| {
            let operations: Vec<_> = control
                .running
                .iter()
                .filter_map(|(&id, running)| {
                    Some(PendingOperation {
                        id,
                        operation: running.operation.clone()?,
                        cancelling: running.cancel.is_cancelled(),
                    })
                })
                .collect();
            let login_id = control.login.as_ref().map(|login| login.id);
            let changed = snapshot.operations != operations
                || snapshot.login_id != login_id
                || snapshot.shutting_down != control.shutting_down;
            snapshot.operations = operations;
            snapshot.login_id = login_id;
            snapshot.shutting_down = control.shutting_down;
            changed
        });
    }

    fn start_job<T: Send + 'static>(
        &self,
        operation: Operation,
        access: Access,
        allocating: bool,
        work: impl FnOnce(u64, &dyn Backend, &CancelToken) -> Result<T> + Send + 'static,
    ) -> Result<Submission<T>> {
        let mut control = self.lock();
        if control.shutting_down {
            return Err(Error::cancelled());
        }
        let expected = match &access {
            Access::Independent | Access::HostWrite | Access::Runtime => None,
            Access::Account(account) | Access::AccountWrite(account) => Some(account),
        };
        if let Some(expected) = expected {
            self.check_account_context(expected)?;
        }
        if let Some((&id, _)) = control
            .running
            .iter()
            .find(|(_, running)| running.operation.as_ref() == Some(&operation))
        {
            return Ok(Submission::AlreadyRunning { id });
        }
        let slot = match access {
            Access::Independent => Slot::Independent,
            Access::Account(_) | Access::Runtime => Slot::Shared,
            Access::AccountWrite(_) | Access::HostWrite => Slot::Exclusive,
        };
        // Core's failed-allocation cleanup can reap any newly seen unnamed VM.
        if !control.available(slot)
            || (allocating && control.running.values().any(|running| running.allocating))
        {
            return Err(Error::new(ErrorKind::Busy));
        }
        let job = self.reserve(&mut control, Some(operation), slot, allocating);
        let expected = expected.cloned();
        Ok(self.launch(job, move |job| {
            // An account write is visible and reserves the slot while the current poll finishes.
            let _poll = (slot == Slot::Exclusive).then(|| job.state.lock_poll_slot());
            job.cancel.check()?;
            if let Some(expected) = expected {
                job.state.verify_account(&expected, &job.cancel)?;
            }
            work(job.id, &*job.state.0.backend, &job.cancel)
        }))
    }

    fn check_account_context(&self, expected: &AccountContext) -> Result<()> {
        let snapshot = self.0.snapshots.borrow();
        if let Some(error) = snapshot.accounts_error {
            return Err(Error::new(error));
        }
        if snapshot.accounts.is_none() {
            return Err(Error::new(ErrorKind::Busy));
        }
        if &snapshot.account != expected {
            return Err(Error::new(ErrorKind::AccountNotActive));
        }
        Ok(())
    }

    fn verify_account(&self, expected: &AccountContext, cancel: &CancelToken) -> Result<()> {
        match self.0.backend.accounts(cancel) {
            Ok(view) => {
                self.record_accounts(Ok(view));
                self.check_account_context(expected)
            }
            Err(error) => {
                if !error.is(ErrorKind::Cancelled) {
                    self.record_accounts(Err(Error::new(error.kind)));
                }
                Err(error)
            }
        }
    }

    fn lock_poll_slot(&self) -> PollSlotGuard<'_> {
        self.0.poll_slot.lock()
    }

    fn lock_poll_slot_cancellable(&self, cancel: &CancelToken) -> Result<PollSlotGuard<'_>> {
        self.0.poll_slot.lock_cancellable(cancel)
    }

    fn wake_poll_slot_waiters(&self) {
        self.0.poll_slot.notify_waiters();
    }

    fn record_accounts(&self, result: Result<AccountsView>) {
        let now = self.0.backend.now();
        self.update(|snapshot| match result {
            Ok(mut view) => {
                if view.recovered_pending_add {
                    snapshot.recovered_pending_add_latched = true;
                }
                view.recovered_pending_add = snapshot.recovered_pending_add_latched;
                let usage = view
                    .accounts
                    .iter_mut()
                    .map(|account| {
                        let mut usage = snapshot
                            .usage
                            .iter()
                            .find(|usage| usage.account == account.id)
                            .cloned()
                            .unwrap_or_else(|| {
                                colab_playground_core::backend::usage_view(
                                    &account.id,
                                    account.email.clone(),
                                    &colab_playground_core::usage::AccountUsage {
                                        snapshot: account.usage.map(polling::stale_sample),
                                        ..Default::default()
                                    },
                                    0,
                                )
                            });
                        if let Some(sample) = &mut usage.snapshot {
                            polling::expire_sample(sample, now);
                        }
                        account.usage = usage.snapshot;
                        usage
                    })
                    .collect();
                if snapshot.account.active != view.active {
                    snapshot.account.revision += 1;
                    snapshot.account.active.clone_from(&view.active);
                    if let Some(runtimes) = &mut snapshot.runtimes {
                        for runtime in &mut runtimes.runtimes {
                            runtime.on_active_account =
                                Some(&runtime.id.account) == view.active.as_ref();
                        }
                    }
                }
                let changed = snapshot.accounts_error.take().is_some()
                    || snapshot.accounts.as_ref() != Some(&view)
                    || snapshot.usage != usage;
                snapshot.accounts = Some(view);
                snapshot.usage = usage;
                changed
            }
            Err(error) => {
                let changed = snapshot.accounts_error != Some(error.kind);
                snapshot.accounts_error = Some(error.kind);
                changed
            }
        });
    }

    fn reserve(
        &self,
        control: &mut Control,
        operation: Option<Operation>,
        access: Slot,
        allocating: bool,
    ) -> Job {
        control.next_id += 1;
        let id = control.next_id;
        let cancel = CancelToken::new();
        control.running.insert(
            id,
            Running {
                operation,
                cancel: cancel.clone(),
                access,
                allocating,
            },
        );
        self.publish_operations(control);
        Job {
            state: self.clone(),
            id,
            cancel,
            finished: false,
        }
    }

    fn launch<T: Send + 'static>(
        &self,
        job: Job,
        work: impl FnOnce(&Job) -> Result<T> + Send + 'static,
    ) -> Submission<T> {
        let id = job.id;
        let job = spawn_blocking(move || {
            let result = job.cancel.check().and_then(|()| work(&job));
            if result
                .as_ref()
                .is_err_and(|e| e.is(ErrorKind::OrphanSuspected))
            {
                job.state.lock().uncertain_cleanup = true;
            }
            result
        });
        Submission::Started { id, job }
    }
}

impl Control {
    fn available(&self, slot: Slot) -> bool {
        !self.shutting_down
            && match slot {
                Slot::Independent => true,
                Slot::Shared | Slot::Poll => {
                    self.login.is_none()
                        && !self
                            .running
                            .values()
                            .any(|job| job.access == Slot::Exclusive)
                }
                Slot::Exclusive => {
                    self.login.is_none()
                        && self
                            .running
                            .values()
                            .all(|job| matches!(job.access, Slot::Independent | Slot::Poll))
                }
            }
    }
}

fn required_account(account: &AccountContext) -> Result<AccountId> {
    account
        .active
        .clone()
        .ok_or_else(|| Error::new(ErrorKind::NoActiveAccount))
}

fn list_account(
    backend: &dyn Backend,
    cancel: &CancelToken,
    account: &AccountId,
) -> Result<RuntimesView> {
    let view = backend.runtimes(cancel)?;
    if let Some(failure) = view.errors.iter().find(|error| &error.account == account) {
        return Err(failure.error.clone());
    }
    Ok(view)
}

fn run_allocation<T>(
    backend: &dyn Backend,
    cancel: &CancelToken,
    account: &AccountId,
    session: &str,
    stop_on_failure: bool,
    work: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let find = |token| -> Result<Option<RuntimeRef>> {
        Ok(list_account(backend, token, account)?
            .runtimes
            .into_iter()
            .map(|runtime| runtime.id)
            .find(|id| &id.account == account && id.name.as_deref() == Some(session)))
    };
    if find(cancel)?.is_some() {
        return Err(Error::invalid(
            "name",
            "a session with this name already exists",
        ));
    }
    let result = work();
    // A cancel can win after core returns success, and plugin cleanup may fail to stop its VM.
    let needs_cleanup = match &result {
        Ok(_) => cancel.commit().is_err(),
        Err(error) => stop_on_failure || cancel.is_cancelled() || error.is(ErrorKind::Cancelled),
    };
    if needs_cleanup {
        let token = CancelToken::new();
        let cleanup = || -> Result<()> {
            if let Some(target) = find(&token)? {
                if let Err(error) = backend.stop_session(&target, Default::default(), &token)
                    && !error.is(ErrorKind::SessionGone)
                {
                    return Err(error);
                }
                if find(&token)?.is_some() {
                    return Err(Error::new(ErrorKind::OrphanSuspected));
                }
            }
            Ok(())
        };
        cleanup().map_err(|_| Error::new(ErrorKind::OrphanSuspected).with("name", session))?;
        return result.and(Err(Error::cancelled()));
    }
    result
}

#[cfg(test)]
mod tests;
