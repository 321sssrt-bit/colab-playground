mod login;
mod polling;
mod shutdown;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use colab_playground_core::{
    CancelToken, Error, ErrorKind, Result,
    accounts::{AccountId, AccountsView},
    backend::{
        AccountUsageView, Backend, BackendKind, Events, GuardReport, PluginRunEvent,
        PluginRunOutcome, PluginRunSpec, RunTarget, RuntimeRef, RuntimesView,
    },
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    tunnel::TunnelInfo,
};
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Notify, watch},
    task::{JoinHandle, spawn_blocking},
};

pub use login::LoginPrompt;
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
    Provision { session: String },
    PluginRun { plugin: String, session: String },
    SwitchAccount { to: AccountId },
    Login,
    Domain { name: &'static str, key: String },
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
    pub runtimes: Option<RuntimesView>,
    pub runtimes_error: Option<ErrorKind>,
    pub tunnels: Vec<TunnelInfo>,
    pub usage: Vec<AccountUsageView>,
    pub guard: Option<GuardReport>,
    pub guard_error: Option<ErrorKind>,
    pub operations: Vec<PendingOperation>,
    pub login_pending: bool,
    pub shutting_down: bool,
}

#[derive(Debug, Clone)]
pub enum Access {
    Independent,
    Account(AccountContext),
    AccountWrite(AccountContext),
}

#[derive(Clone)]
pub struct WebState(Arc<Inner>);

struct Inner {
    backend: Arc<dyn Backend>,
    control: Mutex<Control>,
    snapshots: watch::Sender<Arc<Snapshot>>,
    refresh: Notify,
    drained: Notify,
    login_inactivity: Duration,
}

#[derive(Default)]
struct Control {
    next_id: u64,
    running: BTreeMap<u64, Running>,
    login: Option<login::PendingLogin>,
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
}

impl Drop for Job {
    fn drop(&mut self) {
        let mut control = self.state.lock();
        let running = control.running.remove(&self.id).expect("reserved job");
        self.state.publish_operations(&control);
        if running.operation.is_some() {
            self.state.0.refresh.notify_one();
        }
        if control.running.is_empty() {
            self.state.0.drained.notify_one();
        }
    }
}

impl WebState {
    pub async fn start(backend: Arc<dyn Backend>) -> Result<Self> {
        Self::start_with_timeout(backend, LOGIN_INACTIVITY).await
    }

    async fn start_with_timeout(
        backend: Arc<dyn Backend>,
        login_inactivity: Duration,
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
            runtimes: None,
            runtimes_error: None,
            tunnels: Vec::new(),
            usage: Vec::new(),
            guard: None,
            guard_error: None,
            operations: Vec::new(),
            login_pending: false,
            shutting_down: false,
        }));
        let state = Self(Arc::new(Inner {
            backend,
            control: Mutex::default(),
            snapshots,
            refresh: Notify::new(),
            drained: Notify::new(),
            login_inactivity,
        }));
        tokio::spawn(state.clone().poll());
        Ok(state)
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.0.snapshots.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.0.snapshots.subscribe()
    }

    /// Domain adapters supply a stable, non-secret key. Dropping the handle leaves the job running.
    pub fn start_operation<T: Send + 'static>(
        &self,
        name: &'static str,
        key: String,
        access: Access,
        work: impl FnOnce(&dyn Backend, &CancelToken) -> Result<T> + Send + 'static,
    ) -> Result<Submission<T>> {
        self.start_job(Operation::Domain { name, key }, access, false, work)
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
            move |backend, cancel| {
                run_allocation(backend, cancel, &active, &session, || {
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
        let active = required_account(&account)?;
        let (session, allocating) = match (&spec.target, &existing) {
            (RunTarget::Existing { name }, Some(target))
                if target.account == active && target.name.as_ref() == Some(name) =>
            {
                (name.clone(), false)
            }
            (RunTarget::Provision(provision), None) => {
                provision.validate()?;
                (provision.name.clone(), true)
            }
            _ => {
                return Err(Error::invalid(
                    "target",
                    "runtime precondition does not match",
                ));
            }
        };
        self.start_job(
            Operation::PluginRun {
                plugin: spec.plugin.clone(),
                session: session.clone(),
            },
            Access::Account(account),
            allocating,
            move |backend, cancel| {
                let run = || backend.run_plugin(spec, events, cancel);
                if let Some(target) = existing {
                    let view = list_account(backend, cancel, &target.account)?;
                    if !view.runtimes.iter().any(|runtime| runtime.id == target) {
                        return Err(Error::new(ErrorKind::SessionGone));
                    }
                    run()
                } else {
                    run_allocation(backend, cancel, &active, &session, run)
                }
            },
        )
    }

    pub fn switch_account(
        &self,
        account: AccountContext,
        to: AccountId,
    ) -> Result<Submission<AccountsView>> {
        let state = self.clone();
        self.start_job(
            Operation::SwitchAccount { to: to.clone() },
            Access::AccountWrite(account),
            false,
            move |backend, cancel| {
                let result = backend.switch_account(&to, cancel);
                state.record_accounts(result.clone());
                result
            },
        )
    }

    pub fn cancel(&self, id: u64) -> bool {
        let control = self.lock();
        let cancelled = control
            .running
            .get(&id)
            .is_some_and(|running| running.operation.is_some() && running.cancel.cancel());
        if cancelled {
            self.publish_operations(&control);
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
            let login_pending = control.login.is_some();
            let changed = snapshot.operations != operations
                || snapshot.login_pending != login_pending
                || snapshot.shutting_down != control.shutting_down;
            snapshot.operations = operations;
            snapshot.login_pending = login_pending;
            snapshot.shutting_down = control.shutting_down;
            changed
        });
    }

    fn start_job<T: Send + 'static>(
        &self,
        operation: Operation,
        access: Access,
        allocating: bool,
        work: impl FnOnce(&dyn Backend, &CancelToken) -> Result<T> + Send + 'static,
    ) -> Result<Submission<T>> {
        let mut control = self.lock();
        if control.shutting_down {
            return Err(Error::cancelled());
        }
        let expected = match &access {
            Access::Independent => None,
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
            Access::Account(_) => Slot::Shared,
            Access::AccountWrite(_) => Slot::Exclusive,
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
            if let Some(expected) = expected {
                job.state.verify_account(&expected, &job.cancel)?;
            }
            work(&*job.state.0.backend, &job.cancel)
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
        let result = self.0.backend.accounts(cancel);
        if result
            .as_ref()
            .is_ok_and(|view| view.active == expected.active)
        {
            return self.check_account_context(expected);
        }
        let error = result.as_ref().err().map(|error| error.kind);
        if error != Some(ErrorKind::Cancelled) {
            self.record_accounts(result);
        }
        Err(Error::new(error.unwrap_or(ErrorKind::AccountNotActive)))
    }

    fn record_accounts(&self, result: Result<AccountsView>) {
        self.update(|snapshot| match result {
            Ok(view) => {
                if snapshot.account.active != view.active {
                    snapshot.account.revision += 1;
                    snapshot.account.active.clone_from(&view.active);
                }
                let changed = snapshot.accounts_error.take().is_some()
                    || snapshot.accounts.as_ref() != Some(&view);
                snapshot.accounts = Some(view);
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
                Slot::Shared => {
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
                            .all(|job| job.access == Slot::Independent)
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
        Err(error) => cancel.is_cancelled() || error.is(ErrorKind::Cancelled),
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
