mod accounts;
pub mod environment;
mod forwards;
mod login;
pub mod plugins;
mod polling;
pub mod sessions;
mod shutdown;

use std::{
    collections::BTreeMap,
    sync::{Arc, Condvar, Mutex, MutexGuard, RwLock},
    time::{Duration, SystemTime},
};

use colab_playground_core::{
    CancelToken, Defaults, Error, ErrorKind, Result,
    accounts::{AccountId, AccountsView},
    backend::{
        AccountUsageView, Backend, BackendKind, Events, GuardReport, PluginRunEvent,
        PluginRunOutcome, PluginRunSpec, RuntimeRef, RuntimesView,
    },
    clock::serde_secs,
    host::ProbeReport,
    plugins::ResolvedEndpoint,
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    sessions::HardwareRate,
    tunnel::{TunnelId, TunnelInfo},
};
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Notify, watch},
    task::{JoinHandle, spawn_blocking},
};

pub use accounts::{AccountSwitchApproval, AccountSwitchPreview};
pub use environment::{
    CliInstallEvent, CliInstallEvents, CliInstallOutcome, CliInstallPhase, CliInstallSnapshot,
    CliInstallStart, CliInstallSummary, INSTALL_CLI_OP,
};
pub use forwards::ForwardPolicy;
pub use login::{CancelLoginOutcome, LoginPrompt, SubmitCancelOutcome, SubmitCancelSettlement};
pub use sessions::{EndReason, EndedRuntime, GuardEvent, GuardEventKind};
pub use shutdown::{Billing, ShutdownReport};

const LOGIN_INACTIVITY: Duration = Duration::from_secs(5 * 60);
const REBUILD_BACKEND_OP: &str = "rebuild_backend";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsNotice {
    pub corrupt: bool,
    pub corrupt_backup: Option<String>,
    pub reset_defaults: Vec<String>,
}

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

impl Operation {
    fn refreshes_overview(&self) -> bool {
        match self {
            Self::Domain { name, .. } => !matches!(
                *name,
                "stop_runtime"
                    | "auto_stop"
                    | "stop_all_runtimes"
                    | "open_forward"
                    | "close_forward"
                    | "hf_token"
                    | "inspect_plugin"
                    | "install_plugin"
                    | "set_plugin_enabled"
                    | "remove_plugin"
                    | environment::INSTALL_CLI_OP
                    | REBUILD_BACKEND_OP
            ),
            Self::Provision { .. }
            | Self::PluginRun { .. }
            | Self::SwitchAccount { .. }
            | Self::Login { .. } => true,
        }
    }
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
    #[serde(with = "serde_secs")]
    pub server_now: SystemTime,
    #[serde(skip)]
    usage_now: SystemTime,
    #[serde(skip)]
    cli_installed: Option<bool>,
    #[serde(skip)]
    pending_managed_check: bool,
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
    pub measured_rates: Vec<HardwareRate>,
    pub guard: Option<GuardReport>,
    pub guard_events: Vec<GuardEvent>,
    pub guard_error: Option<ErrorKind>,
    pub ended: Vec<EndedRuntime>,
    #[serde(skip)]
    guard_state: sessions::GuardLedger,
    pub cli_install: CliInstallSummary,
    pub settings_notice: Option<SettingsNotice>,
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
    backend: RwLock<Arc<dyn Backend>>,
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
    cli_install: Mutex<Option<Arc<environment::CliInstallSession>>>,
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
        if running.allocating {
            self.state.mark_pending_managed_check();
        }
        if running
            .operation
            .as_ref()
            .is_some_and(Operation::refreshes_overview)
        {
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
        let (backend, kind, now, measured_rates) = spawn_blocking(move || {
            let kind = backend.kind();
            let now = backend.now();
            let measured_rates = backend.measured_rates();
            (backend, kind, now, measured_rates)
        })
        .await
        .map_err(|_| Error::new(ErrorKind::Other))?;
        let (snapshots, _) = watch::channel(Arc::new(Snapshot {
            version: 1,
            server_now: now,
            usage_now: now,
            cli_installed: None,
            pending_managed_check: false,
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
            measured_rates,
            guard: None,
            guard_events: Vec::new(),
            guard_error: None,
            ended: Vec::new(),
            guard_state: sessions::GuardLedger::default(),
            cli_install: CliInstallSummary::default(),
            settings_notice: None,
            operations: Vec::new(),
            login_id: None,
            shutting_down: false,
        }));
        let state = Self(Arc::new(Inner {
            backend: RwLock::new(backend),
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
            cli_install: Mutex::default(),
        }));
        tokio::spawn(state.clone().poll());
        tokio::spawn(state.clone().poll_forwards());
        Ok(state)
    }

    pub(super) fn backend(&self) -> Arc<dyn Backend> {
        self.0
            .backend
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        let mut snapshot = self.0.snapshots.borrow().clone();
        let now = self.backend().now();
        if snapshot.server_now != now {
            Arc::make_mut(&mut snapshot).server_now = now;
        }
        snapshot
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<Snapshot>> {
        let now = self.backend().now();
        // Refresh the clock in place without notifying existing subscribers or bumping version,
        // so a newly connected SSE client's initial frame carries the current server clock.
        self.0.snapshots.send_if_modified(|snapshot| {
            if snapshot.server_now != now {
                Arc::make_mut(snapshot).server_now = now;
            }
            false
        });
        self.0.snapshots.subscribe()
    }

    pub fn forward_policy(&self) -> ForwardPolicy {
        self.0.forward_policy
    }

    pub fn set_defaults(&self, defaults: Defaults) {
        self.backend().set_defaults(defaults);
    }

    pub fn set_settings_notice(&self, notice: Option<SettingsNotice>) {
        self.update(|snapshot| {
            if snapshot.settings_notice == notice {
                return false;
            }
            snapshot.settings_notice = notice;
            true
        });
    }

    pub fn can_change_host(&self) -> bool {
        self.lock().can_change_host()
    }

    pub fn reset_cli_probe(&self) {
        self.0.snapshots.send_if_modified(|snapshot| {
            if snapshot.cli_installed.is_none() {
                return false;
            }
            Arc::make_mut(snapshot).cli_installed = None;
            false
        });
    }

    /// Runs a host-settings change atomically under an exclusive slot and the poll slot.
    ///
    /// Rejects with `ErrorKind::Busy` when any non-poll operation or pending login is active.
    pub async fn apply_host_change<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&HostChangeCommit<'_>, &CancelToken) -> Result<T> + Send + 'static,
    {
        let operation = Operation::Domain {
            name: REBUILD_BACKEND_OP,
            key: String::new(),
        };
        let job = {
            let mut control = self.lock();
            if control.shutting_down {
                return Err(Error::cancelled());
            }
            if !control.can_change_host() {
                return Err(Error::new(ErrorKind::Busy));
            }
            self.reserve(&mut control, Some(operation), Slot::Exclusive, false)
        };
        let state = self.clone();
        let (output, rebuilt_backend) = spawn_blocking(move || {
            let _poll = job.state.lock_poll_slot();
            job.cancel.check()?;
            let commit = HostChangeCommit {
                state: &job.state,
                rebuilt: Mutex::new(None),
            };
            let output = work(&commit, &job.cancel)?;
            let rebuilt = commit
                .rebuilt
                .into_inner()
                .unwrap_or_else(|e| e.into_inner());
            Ok::<_, Error>((output, rebuilt))
        })
        .await
        .map_err(|_| Error::new(ErrorKind::Other))??;

        if let Some(new_backend) = rebuilt_backend {
            state.spawn_post_rebuild_probe(new_backend);
        }
        Ok(output)
    }

    fn spawn_post_rebuild_probe(&self, expected: Arc<dyn Backend>) {
        let state = self.clone();
        tokio::spawn(async move {
            let _ = spawn_blocking(move || {
                let _poll = state.lock_poll_slot();
                let job = {
                    let mut control = state.lock();
                    if !control.available(Slot::Poll) {
                        return;
                    }
                    state.reserve(&mut control, None, Slot::Poll, false)
                };
                let current = state.backend();
                if !Arc::ptr_eq(&current, &expected) {
                    return;
                }
                match current.probe(&job.cancel) {
                    Ok(report) => {
                        let cli_installed = report.colab.is_some();
                        state.set_cli_installed(cli_installed);
                        if cli_installed {
                            state.refresh_overview(&*current, &job.cancel);
                        } else {
                            state.clear_overview(current.measured_rates());
                        }
                    }
                    Err(error) if error.is(ErrorKind::NotInstalled) => {
                        state.set_cli_installed(false);
                        state.clear_overview(current.measured_rates());
                    }
                    Err(_) => {}
                }
            })
            .await;
        });
    }

    pub async fn run_backend<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn Backend, &CancelToken) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.backend_job(Slot::Independent, work).await
    }

    pub async fn probe_environment(&self) -> Result<(ProbeReport, Arc<Snapshot>, SystemTime)> {
        let (report, snapshot, _, now, ()) = self.probe_environment_with(|| ()).await?;
        Ok((report, snapshot, now))
    }

    /// Probes the host and captures both the CLI install state and caller-supplied host metadata
    /// while holding `Slot::Shared`, preventing a concurrent host rebuild from mixing two hosts
    /// into one response.
    pub async fn probe_environment_with<M, F>(
        &self,
        read_meta: F,
    ) -> Result<(
        ProbeReport,
        Arc<Snapshot>,
        CliInstallSnapshot,
        SystemTime,
        M,
    )>
    where
        M: Send + 'static,
        F: FnOnce() -> M + Send + 'static,
    {
        let state = self.clone();
        self.backend_job(Slot::Shared, move |backend, cancel| {
            let _poll = state.lock_poll_slot();
            cancel.check()?;
            let recheck = state.begin_cli_recheck();
            let report = match backend.probe(cancel) {
                Ok(report) => report,
                Err(error) => {
                    if error.is(ErrorKind::Cancelled) {
                        recheck.restore();
                    } else if error.is(ErrorKind::NotInstalled) {
                        recheck.finish(CliInstallOutcome {
                            phase: CliInstallPhase::NotFound,
                            cli_installed: false,
                            error: None,
                        });
                    } else {
                        recheck.finish(CliInstallOutcome {
                            phase: CliInstallPhase::ProbeFailed,
                            cli_installed: false,
                            error: Some(error.clone()),
                        });
                    }
                    return Err(error);
                }
            };
            let cli_installed = report.colab.is_some();
            state.set_cli_installed(cli_installed);
            if cli_installed {
                state.refresh_overview(backend, cancel);
                recheck.finish(CliInstallOutcome {
                    phase: CliInstallPhase::Succeeded,
                    cli_installed: true,
                    error: None,
                });
            } else {
                state.clear_overview(backend.measured_rates());
                recheck.finish(CliInstallOutcome {
                    phase: CliInstallPhase::NotFound,
                    cli_installed: false,
                    error: None,
                });
            }
            let meta = read_meta();
            let cli_install = state.cli_install_snapshot();
            Ok((report, state.snapshot(), cli_install, backend.now(), meta))
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
            let backend = job.state.backend();
            work(&*backend, &job.cancel)
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
        let (cancelled, is_install) = {
            let control = self.lock();
            let entry = control.running.get(&id);
            let is_install = entry.is_some_and(|running| {
                matches!(
                    running.operation,
                    Some(Operation::Domain {
                        name: environment::INSTALL_CLI_OP,
                        ..
                    })
                )
            });
            let cancelled =
                entry.is_some_and(|running| running.operation.is_some() && running.cancel.cancel());
            if cancelled {
                self.publish_operations(&control);
            }
            (cancelled, is_install)
        };
        if cancelled {
            if is_install {
                self.mark_cli_install_cancelling(id);
            }
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
        let now = self.backend().now();
        self.0.snapshots.send_if_modified(|snapshot| {
            let snapshot = Arc::make_mut(snapshot);
            if change(snapshot) {
                snapshot.server_now = now;
                snapshot.version += 1;
                true
            } else {
                false
            }
        });
    }

    fn set_cli_installed(&self, installed: bool) {
        self.0.snapshots.send_if_modified(|snapshot| {
            if snapshot.cli_installed == Some(installed) {
                return false;
            }
            Arc::make_mut(snapshot).cli_installed = Some(installed);
            // Internal polling gate does not serialize onto the wire.
            false
        });
    }

    fn mark_pending_managed_check(&self) {
        self.0.snapshots.send_if_modified(|snapshot| {
            if snapshot.pending_managed_check {
                return false;
            }
            Arc::make_mut(snapshot).pending_managed_check = true;
            false
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
            let backend = job.state.backend();
            work(job.id, &*backend, &job.cancel)
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
        match self.backend().accounts(cancel) {
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
        self.update(|snapshot| match result {
            Ok(mut view) => {
                snapshot.cli_installed = Some(true);
                if view.recovered_pending_add {
                    snapshot.recovered_pending_add_latched = true;
                }
                view.recovered_pending_add = snapshot.recovered_pending_add_latched;
                let usage = view
                    .accounts
                    .iter_mut()
                    .map(|account| {
                        let usage = snapshot
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
                if error.is(ErrorKind::NotInstalled) {
                    snapshot.cli_installed = Some(false);
                }
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

/// Capability passed into [`WebState::apply_host_change`] while holding `Slot::Exclusive` and
/// the poll slot.
pub struct HostChangeCommit<'a> {
    state: &'a WebState,
    rebuilt: Mutex<Option<Arc<dyn Backend>>>,
}

impl HostChangeCommit<'_> {
    /// Clears staged plugin previews before constructing a new backend whose initialization cleans
    /// staging directories on disk.
    pub fn discard_plugin_previews(&self) {
        self.state.discard_plugin_previews();
    }

    /// Commits a host/WSL/CLI-path change: atomically swaps in `rebuilt` when provided,
    /// clears the previous CLI install state, and resets host-derived snapshot state.
    pub fn commit_host_change(&self, rebuilt: Option<Arc<dyn Backend>>, defaults: Defaults) {
        if let Some(new_backend) = rebuilt {
            self.state.discard_plugin_previews();
            let old_backend = {
                let mut slot = self
                    .state
                    .0
                    .backend
                    .write()
                    .unwrap_or_else(|error| error.into_inner());
                std::mem::replace(&mut *slot, new_backend.clone())
            };
            for tunnel in old_backend.tunnels() {
                let _ = old_backend.close_tunnel(tunnel.id);
            }
            self.state.sync_forwards();
            self.state.clear_cli_install();
            let now = new_backend.now();
            let kind = new_backend.kind();
            let rates = new_backend.measured_rates();
            self.state.update(|snapshot| {
                snapshot.usage_now = now;
                snapshot.cli_installed = None;
                snapshot.pending_managed_check = false;
                snapshot.backend = kind;
                snapshot.account.active = None;
                snapshot.account.revision += 1;
                snapshot.accounts = None;
                snapshot.accounts_error = None;
                snapshot.recovered_pending_add_latched = false;
                snapshot.runtimes = None;
                snapshot.runtimes_error = None;
                snapshot.usage.clear();
                snapshot.measured_rates = rates;
                snapshot.guard = None;
                snapshot.guard_error = None;
                snapshot.guard_state.clear_live();
                snapshot.sync_guard_projection();
                snapshot.cli_install = CliInstallSummary::default();
                snapshot.settings_notice = None;
                true
            });
            *self
                .rebuilt
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(new_backend);
        } else {
            self.state.backend().set_defaults(defaults);
            self.state.clear_cli_install();
            self.state.reset_cli_probe();
            self.state.set_settings_notice(None);
        }
    }

    pub fn commit_non_host_change(&self, defaults: Defaults) {
        self.state.backend().set_defaults(defaults);
        self.state.set_settings_notice(None);
    }
}

impl Control {
    fn is_rebuilding(&self) -> bool {
        self.running.values().any(|job| {
            matches!(
                job.operation,
                Some(Operation::Domain {
                    name: REBUILD_BACKEND_OP,
                    ..
                })
            )
        })
    }

    fn can_change_host(&self) -> bool {
        !self.shutting_down
            && self.login.is_none()
            && self.running.values().all(|job| job.access == Slot::Poll)
    }

    fn available(&self, slot: Slot) -> bool {
        !self.shutting_down
            && !self.is_rebuilding()
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
