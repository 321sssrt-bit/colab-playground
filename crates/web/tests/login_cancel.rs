use std::{
    io::{BufRead as _, BufReader, Write as _},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime},
};

use colab_playground_core::{
    CancelToken, Error, ErrorKind, Result,
    accounts::{Account, AccountId, AccountsView},
    backend::{
        AccountUsageView, Backend, BackendKind, Events, Extension, GuardReport, InstallMethod,
        LoginFlow, PluginRunEvent, PluginRunOutcome, PluginRunSpec, RuntimeRef, RuntimesView,
        StopOptions, SwitchImpact,
    },
    defaults::Defaults,
    hf::HfModel,
    host::{Line, ProbeReport},
    mock::{MockBackend, MockConfig, MockFailures, MockScenario},
    plugins::{PluginInfo, PluginPreview},
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    quant::GgufListing,
    sessions::{HardwareRate, WatchdogInfo},
    tunnel::{TunnelEvent, TunnelId, TunnelInfo, TunnelSpec},
};
use colab_playground_web::state::{
    Access, CancelLoginOutcome, Snapshot, Submission, SubmitCancelOutcome, WebState,
};
use sha2::{Digest as _, Sha256};
use tokio::time::{sleep, timeout};

const TEST_TIMEOUT: Duration = Duration::from_secs(8);

fn started<T>(submission: Submission<T>) -> (u64, tokio::task::JoinHandle<Result<T>>) {
    match submission {
        Submission::Started { id, job } => (id, job),
        Submission::AlreadyRunning { .. } => panic!("expected a new operation"),
    }
}

async fn wait_ready(state: &WebState) -> Arc<Snapshot> {
    let mut snapshots = state.subscribe();
    timeout(TEST_TIMEOUT, async {
        loop {
            let snapshot = state.snapshot();
            if snapshot.accounts.is_some()
                && snapshot.runtimes.is_some()
                && snapshot.operations.is_empty()
            {
                return snapshot;
            }
            tokio::select! {
                _ = snapshots.changed() => {}
                _ = sleep(Duration::from_millis(10)) => {}
            }
        }
    })
    .await
    .unwrap()
}

type BeginHook =
    Box<dyn FnOnce(&MockBackend, &CancelToken) -> Result<Box<dyn LoginFlow>> + Send + 'static>;
type RuntimesHook =
    Box<dyn FnOnce(&MockBackend, &CancelToken) -> Result<RuntimesView> + Send + 'static>;

struct ControlledBackend {
    inner: MockBackend,
    begin_hook: Mutex<Option<BeginHook>>,
    runtimes_hook: Mutex<Option<RuntimesHook>>,
    accounts_calls: AtomicUsize,
    fail_accounts_once: AtomicBool,
}

impl ControlledBackend {
    fn new(inner: MockBackend) -> Arc<Self> {
        Arc::new(Self {
            inner,
            begin_hook: Mutex::new(None),
            runtimes_hook: Mutex::new(None),
            accounts_calls: AtomicUsize::new(0),
            fail_accounts_once: AtomicBool::new(false),
        })
    }

    fn set_begin_hook(
        &self,
        hook: impl FnOnce(&MockBackend, &CancelToken) -> Result<Box<dyn LoginFlow>> + Send + 'static,
    ) {
        *self.begin_hook.lock().unwrap() = Some(Box::new(hook));
    }

    fn clear_begin_hook(&self) {
        *self.begin_hook.lock().unwrap() = None;
    }

    fn set_runtimes_hook(
        &self,
        hook: impl FnOnce(&MockBackend, &CancelToken) -> Result<RuntimesView> + Send + 'static,
    ) {
        *self.runtimes_hook.lock().unwrap() = Some(Box::new(hook));
    }
}

impl Backend for ControlledBackend {
    fn kind(&self) -> BackendKind {
        self.inner.kind()
    }
    fn defaults(&self) -> Defaults {
        self.inner.defaults()
    }
    fn set_defaults(&self, defaults: Defaults) {
        self.inner.set_defaults(defaults);
    }
    fn now(&self) -> SystemTime {
        self.inner.now()
    }
    fn probe(&self, cancel: &CancelToken) -> Result<ProbeReport> {
        self.inner.probe(cancel)
    }
    fn install_cli(
        &self,
        method: InstallMethod,
        log: Events<Line>,
        cancel: &CancelToken,
    ) -> Result<()> {
        self.inner.install_cli(method, log, cancel)
    }
    fn accounts(&self, cancel: &CancelToken) -> Result<AccountsView> {
        self.accounts_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_accounts_once.swap(false, Ordering::SeqCst) {
            return Err(Error::new(ErrorKind::KeyringUnavailable));
        }
        self.inner.accounts(cancel)
    }
    fn adopt_active_account(&self, cancel: &CancelToken) -> Result<Account> {
        self.inner.adopt_active_account(cancel)
    }
    fn begin_add_account(&self, cancel: &CancelToken) -> Result<Box<dyn LoginFlow>> {
        let hook = self.begin_hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook(&self.inner, cancel)
        } else {
            self.inner.begin_add_account(cancel)
        }
    }
    fn switch_impact(&self, to: &AccountId) -> Result<SwitchImpact> {
        self.inner.switch_impact(to)
    }
    fn switch_account(&self, to: &AccountId, cancel: &CancelToken) -> Result<AccountsView> {
        self.inner.switch_account(to, cancel)
    }
    fn remove_account(&self, id: &AccountId, cancel: &CancelToken) -> Result<()> {
        self.inner.remove_account(id, cancel)
    }
    fn refresh_usage(
        &self,
        accounts: &[AccountId],
        cancel: &CancelToken,
    ) -> Result<Vec<AccountUsageView>> {
        self.inner.refresh_usage(accounts, cancel)
    }
    fn usage(&self) -> Vec<AccountUsageView> {
        self.inner.usage()
    }
    fn usage_poll_due(&self) -> bool {
        self.inner.usage_poll_due()
    }
    fn measured_rates(&self) -> Vec<HardwareRate> {
        self.inner.measured_rates()
    }
    fn runtimes(&self, cancel: &CancelToken) -> Result<RuntimesView> {
        let hook = self.runtimes_hook.lock().unwrap().take();
        if let Some(hook) = hook {
            return hook(&self.inner, cancel);
        }
        self.inner.runtimes(cancel)
    }
    fn new_session_name(&self, prefix: Option<&str>) -> String {
        self.inner.new_session_name(prefix)
    }
    fn provision(
        &self,
        spec: ProvisionSpec,
        events: Events<ProvisionEvent>,
        cancel: &CancelToken,
    ) -> Result<ProvisionOutcome> {
        self.inner.provision(spec, events, cancel)
    }
    fn stop_session(
        &self,
        target: &RuntimeRef,
        options: StopOptions,
        cancel: &CancelToken,
    ) -> Result<()> {
        self.inner.stop_session(target, options, cancel)
    }
    fn extend_session(
        &self,
        target: &RuntimeRef,
        by: Duration,
        cancel: &CancelToken,
    ) -> Result<Extension> {
        self.inner.extend_session(target, by, cancel)
    }
    fn set_auto_stop(
        &self,
        target: &RuntimeRef,
        runtime: Duration,
        cancel: &CancelToken,
    ) -> Result<WatchdogInfo> {
        self.inner.set_auto_stop(target, runtime, cancel)
    }
    fn cancel_auto_stop(&self, target: &RuntimeRef, cancel: &CancelToken) -> Result<()> {
        self.inner.cancel_auto_stop(target, cancel)
    }
    fn guard_poll(&self, cancel: &CancelToken) -> Result<GuardReport> {
        self.inner.guard_poll(cancel)
    }
    fn open_tunnel(&self, spec: TunnelSpec, events: Events<TunnelEvent>) -> Result<TunnelId> {
        self.inner.open_tunnel(spec, events)
    }
    fn close_tunnel(&self, id: TunnelId) -> Result<()> {
        self.inner.close_tunnel(id)
    }
    fn tunnels(&self) -> Vec<TunnelInfo> {
        self.inner.tunnels()
    }
    fn plugins(&self) -> Vec<PluginInfo> {
        self.inner.plugins()
    }
    fn plugin_run_template(&self, plugin: &str) -> Result<PluginRunSpec> {
        self.inner.plugin_run_template(plugin)
    }
    fn inspect_plugin_folder(&self, path: &Path) -> Result<PluginPreview> {
        self.inner.inspect_plugin_folder(path)
    }
    fn inspect_plugin_git(&self, url: &str, cancel: &CancelToken) -> Result<PluginPreview> {
        self.inner.inspect_plugin_git(url, cancel)
    }
    fn install_plugin(&self, preview: &PluginPreview) -> Result<PluginInfo> {
        self.inner.install_plugin(preview)
    }
    fn discard_plugin_preview(&self, preview: &PluginPreview) {
        self.inner.discard_plugin_preview(preview);
    }
    fn set_plugin_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        self.inner.set_plugin_enabled(id, enabled)
    }
    fn remove_plugin(&self, id: &str) -> Result<()> {
        self.inner.remove_plugin(id)
    }
    fn run_plugin(
        &self,
        spec: PluginRunSpec,
        events: Events<PluginRunEvent>,
        cancel: &CancelToken,
    ) -> Result<PluginRunOutcome> {
        self.inner.run_plugin(spec, events, cancel)
    }
    fn set_secret(&self, name: &str, value: &str, cancel: &CancelToken) -> Result<()> {
        self.inner.set_secret(name, value, cancel)
    }
    fn has_secret(&self, name: &str, cancel: &CancelToken) -> Result<bool> {
        self.inner.has_secret(name, cancel)
    }
    fn delete_secret(&self, name: &str, cancel: &CancelToken) -> Result<()> {
        self.inner.delete_secret(name, cancel)
    }
    fn hf_search(&self, query: &str, limit: u32, cancel: &CancelToken) -> Result<Vec<HfModel>> {
        self.inner.hf_search(query, limit, cancel)
    }
    fn hf_files(&self, repo: &str, cancel: &CancelToken) -> Result<GgufListing> {
        self.inner.hf_files(repo, cancel)
    }
}

type SubmitHook =
    Box<dyn FnOnce(Box<dyn LoginFlow>, &str, &CancelToken) -> Result<Account> + Send + 'static>;
type CancelHook = Box<dyn FnOnce(Box<dyn LoginFlow>) -> Result<()> + Send + 'static>;

struct GateLoginFlow {
    inner: Box<dyn LoginFlow>,
    url: String,
    submit_fn: Option<SubmitHook>,
    cancel_fn: Option<CancelHook>,
}

impl GateLoginFlow {
    fn wrap(
        inner: Box<dyn LoginFlow>,
        submit_fn: impl FnOnce(Box<dyn LoginFlow>, &str, &CancelToken) -> Result<Account>
        + Send
        + 'static,
        cancel_fn: impl FnOnce(Box<dyn LoginFlow>) -> Result<()> + Send + 'static,
    ) -> Box<dyn LoginFlow> {
        let url = inner.auth_url().to_owned();
        Box::new(Self {
            inner,
            url,
            submit_fn: Some(Box::new(submit_fn)),
            cancel_fn: Some(Box::new(cancel_fn)),
        })
    }
}

impl LoginFlow for GateLoginFlow {
    fn auth_url(&self) -> &str {
        &self.url
    }

    fn submit_code(mut self: Box<Self>, code: &str, cancel: &CancelToken) -> Result<Account> {
        let submit = self.submit_fn.take().expect("submit once");
        submit(self.inner, code, cancel)
    }

    fn cancel(mut self: Box<Self>) -> Result<()> {
        let cancel = self.cancel_fn.take().expect("cancel once");
        cancel(self.inner)
    }
}

fn demo_backend() -> Arc<ControlledBackend> {
    let (config, _) = MockConfig::headless(MockScenario::demo());
    ControlledBackend::new(MockBackend::new(config))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starting_cancel_interrupts_immediately_and_releases_lock() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();
    let other = initial.accounts.as_ref().unwrap().accounts[1].id.clone();

    let (entered_tx, entered_rx) = mpsc::channel();
    backend.set_begin_hook(move |_mock, cancel| {
        entered_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !cancel.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        panic!("begin_add_account was not interrupted promptly");
    });

    let started_at = Instant::now();
    let (id, begin_job) = started(state.begin_login(account.clone()).unwrap());
    entered_rx.recv_timeout(TEST_TIMEOUT).unwrap();

    // Cancel by id during starting must interrupt immediately and release the exclusive lock.
    let outcome = timeout(Duration::from_secs(2), state.cancel_login_settled(id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome, CancelLoginOutcome::RolledBack);
    assert!(
        started_at.elapsed() < Duration::from_secs(2),
        "starting cancel must not wait on the 90s CLI timeout"
    );
    assert!(matches!(
        begin_job.await.unwrap(),
        Err(error) if error.is(ErrorKind::Cancelled)
    ));
    let after = state.snapshot();
    assert!(after.login_id.is_none());
    assert!(after.operations.is_empty());

    // Immediately starting a new login or switching accounts succeeds without Busy.
    backend.clear_begin_hook();
    let (_, retry_begin) = started(state.begin_login(account.clone()).unwrap());
    let prompt = retry_begin.await.unwrap().unwrap();
    assert_eq!(
        state.cancel_login_settled(prompt.id).await.unwrap(),
        CancelLoginOutcome::RolledBack
    );
    let (_, switch_job) = started(state.switch_account(account, other.clone()).unwrap());
    assert_eq!(switch_job.await.unwrap().unwrap().active, Some(other));
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starting_cancel_while_slow_poll_holds_poll_slot_releases_lock_immediately() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();

    let (poll_entered_tx, poll_entered_rx) = mpsc::channel();
    let (release_poll_tx, release_poll_rx) = mpsc::channel();
    backend.set_runtimes_hook(move |mock, cancel| {
        poll_entered_tx.send(()).unwrap();
        release_poll_rx.recv_timeout(TEST_TIMEOUT).unwrap();
        mock.runtimes(cancel)
    });

    // Trigger a real background `Slot::Poll` cycle (simulating a slow 120s helper call holding
    // `poll_slot` while `Slot::Exclusive` is still allowed to start).
    let (_, trigger) = started(
        state
            .start_operation(
                "trigger_poll",
                String::new(),
                Access::Independent,
                |_, _| Ok(()),
            )
            .unwrap(),
    );
    trigger.await.unwrap().unwrap();
    poll_entered_rx.recv_timeout(TEST_TIMEOUT).unwrap();

    // `begin_login` reserves Slot::Exclusive and waits on `poll_slot`; cancelling it must
    // abort immediately without waiting for the slow background poll to finish.
    let (id, begin_job) = started(state.begin_login(account.clone()).unwrap());
    let outcome = timeout(Duration::from_secs(1), state.cancel_login_settled(id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome, CancelLoginOutcome::RolledBack);
    assert!(matches!(
        begin_job.await.unwrap(),
        Err(error) if error.is(ErrorKind::Cancelled)
    ));
    assert!(state.snapshot().operations.is_empty());
    assert!(state.snapshot().login_id.is_none());

    // A follow-up login is accepted immediately (not Busy) even while the slow poll is still
    // running, and completes cleanly once the poll finishes.
    let (_, retry_begin) = started(state.begin_login(account).unwrap());
    release_poll_tx.send(()).unwrap();
    let prompt = retry_begin.await.unwrap().unwrap();
    assert_eq!(
        state.cancel_login_settled(prompt.id).await.unwrap(),
        CancelLoginOutcome::RolledBack
    );
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starting_cancel_handoff_race_and_stale_id_isolation() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();

    // Part 1: cancel arrives right as `begin_add_account` returns a flow:
    // WebState must roll back that flow via `flow.cancel()` instead of installing PendingLogin.
    let (entered_tx, entered_rx) = mpsc::channel();
    backend.set_begin_hook(move |mock, cancel| {
        entered_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cancel.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        mock.begin_add_account(&CancelToken::new())
    });

    let (first_id, begin_job) = started(state.begin_login(account.clone()).unwrap());
    entered_rx.recv_timeout(TEST_TIMEOUT).unwrap();
    let outcome = timeout(Duration::from_secs(2), state.cancel_login_settled(first_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome, CancelLoginOutcome::RolledBack);
    assert!(matches!(
        begin_job.await.unwrap(),
        Err(error) if error.is(ErrorKind::Cancelled)
    ));
    assert!(state.snapshot().login_id.is_none());
    assert_eq!(
        backend.accounts(&CancelToken::new()).unwrap().active,
        account.active
    );

    // Part 2: aborting after `begin_login` already installed `PendingLogin` still rolls back
    // immediately instead of locking the server for 5 minutes.
    backend.clear_begin_hook();
    let (_, begin_job) = started(state.begin_login(account.clone()).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    assert_eq!(state.snapshot().login_id, Some(prompt.id));
    state.abort_login_start(prompt.id);

    timeout(TEST_TIMEOUT, async {
        loop {
            let snap = state.snapshot();
            if snap.login_id.is_none() && snap.operations.is_empty() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        backend.accounts(&CancelToken::new()).unwrap().active,
        account.active
    );

    // Part 3: a stale/retried cancel carrying an older login id NEVER cancels another tab's login.
    let (_, next_begin) = started(state.begin_login(account).unwrap());
    let next_prompt = next_begin.await.unwrap().unwrap();
    assert_ne!(next_prompt.id, prompt.id);
    assert!(
        state
            .cancel_login_settled(prompt.id)
            .await
            .unwrap_err()
            .is(ErrorKind::LoginCancelled)
    );
    assert_eq!(state.snapshot().login_id, Some(next_prompt.id));
    assert_eq!(
        state.cancel_login_settled(next_prompt.id).await.unwrap(),
        CancelLoginOutcome::RolledBack
    );
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submitting_cancel_waits_for_rollback_and_returns_real_cancelled_state() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();
    let other = initial.accounts.as_ref().unwrap().accounts[1].id.clone();

    let (submitting_tx, submitting_rx) = mpsc::channel();
    let (cancel_seen_tx, cancel_seen_rx) = mpsc::channel();
    let (release_rollback_tx, release_rollback_rx) = mpsc::channel();
    let release_rollback_rx = Arc::new(Mutex::new(release_rollback_rx));
    let rollback_finished = Arc::new(AtomicBool::new(false));
    let rollback_finished_clone = rollback_finished.clone();

    backend.set_begin_hook(move |mock, cancel| {
        let inner = mock.begin_add_account(cancel)?;
        let release_rx = release_rollback_rx.clone();
        let finished = rollback_finished_clone.clone();
        Ok(GateLoginFlow::wrap(
            inner,
            move |inner, _code, cancel| {
                submitting_tx.send(()).unwrap();
                let deadline = Instant::now() + TEST_TIMEOUT;
                while !cancel.is_cancelled() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(cancel.is_cancelled(), "expected cancel during submitting");
                cancel_seen_tx.send(()).unwrap();
                // Hold before rolling back so we can prove cancel_login_settled waits.
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(TEST_TIMEOUT)
                    .unwrap();
                inner.cancel()?;
                finished.store(true, Ordering::SeqCst);
                Err(Error::cancelled())
            },
            |inner| inner.cancel(),
        ))
    });

    let (_, begin_job) = started(state.begin_login(account.clone()).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    let (_, submit_job) = started(state.submit_login(prompt.id, "4/0A-cancel".into()).unwrap());
    submitting_rx.recv_timeout(TEST_TIMEOUT).unwrap();

    // Two concurrent cancel requests during submitting must BOTH wait until rollback finishes.
    let cancel_a = {
        let state = state.clone();
        tokio::spawn(async move { state.cancel_login_settled(prompt.id).await })
    };
    cancel_seen_rx.recv_timeout(TEST_TIMEOUT).unwrap();
    let cancel_b = {
        let state = state.clone();
        tokio::spawn(async move { state.cancel_login_settled(prompt.id).await })
    };

    sleep(Duration::from_millis(80)).await;
    assert!(
        !cancel_a.is_finished() && !cancel_b.is_finished(),
        "cancel_login_settled must not return early while rollback is still in progress"
    );
    assert!(!rollback_finished.load(Ordering::SeqCst));

    release_rollback_tx.send(()).unwrap();
    let settled_a = timeout(TEST_TIMEOUT, cancel_a)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let settled_b = timeout(TEST_TIMEOUT, cancel_b)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(rollback_finished.load(Ordering::SeqCst));

    for settled in [settled_a, settled_b] {
        let CancelLoginOutcome::SubmittingSettled(settled) = settled else {
            panic!("expected SubmittingSettled, got {settled:?}");
        };
        assert_eq!(settled.outcome, SubmitCancelOutcome::Cancelled);
        assert_eq!(
            settled.account_context.as_ref().unwrap().active,
            account.active
        );
        let accounts = settled.accounts.as_ref().unwrap();
        assert_eq!(accounts.active, account.active);
        assert!(accounts.has_token);
        assert!(settled.accounts_error.is_none());
    }
    assert!(
        submit_job
            .await
            .unwrap()
            .unwrap_err()
            .is(ErrorKind::Cancelled)
    );

    // Exclusive lock is already released when cancel_login_settled returns.
    let (_, switch_job) = started(state.switch_account(account, other.clone()).unwrap());
    assert_eq!(switch_job.await.unwrap().unwrap().active, Some(other));
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submitting_cancel_after_point_of_no_return_reports_completed_new_account() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();
    let other = initial.accounts.as_ref().unwrap().accounts[1].id.clone();

    let (submitting_tx, submitting_rx) = mpsc::channel();
    let (release_commit_tx, release_commit_rx) = mpsc::channel();
    let release_commit_rx = Arc::new(Mutex::new(release_commit_rx));

    backend.set_begin_hook(move |mock, cancel| {
        let inner = mock.begin_add_account(cancel)?;
        let release_rx = release_commit_rx.clone();
        Ok(GateLoginFlow::wrap(
            inner,
            move |inner, code, _cancel| {
                submitting_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(TEST_TIMEOUT)
                    .unwrap();
                // Simulate code exchange already past the point of no return in Google/CLI.
                inner.submit_code(code, &CancelToken::new())
            },
            |inner| inner.cancel(),
        ))
    });

    let (_, begin_job) = started(state.begin_login(account.clone()).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    let (_, submit_job) = started(state.submit_login(prompt.id, "4/0A-commit".into()).unwrap());
    submitting_rx.recv_timeout(TEST_TIMEOUT).unwrap();

    let cancel_task = {
        let state = state.clone();
        tokio::spawn(async move { state.cancel_login_settled(prompt.id).await })
    };
    sleep(Duration::from_millis(60)).await;
    assert!(!cancel_task.is_finished());

    release_commit_tx.send(()).unwrap();
    let submitted = submit_job.await.unwrap().unwrap().unwrap();

    // Immediately switch to another account on a racing tab before inspecting the cancel result:
    // the cancel settlement must still report the account state captured before Slot::Exclusive
    // was released, never mixing Account A's `Completed` with Account B's active state.
    let (_, switch_job) = started(
        state
            .switch_account(state.snapshot().account.clone(), other.clone())
            .unwrap(),
    );
    assert_eq!(switch_job.await.unwrap().unwrap().active, Some(other));

    let settled = timeout(TEST_TIMEOUT, cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let CancelLoginOutcome::SubmittingSettled(settled) = settled else {
        panic!("expected SubmittingSettled, got {settled:?}");
    };
    assert_eq!(
        settled.outcome,
        SubmitCancelOutcome::Completed(submitted.clone())
    );
    let settled_ctx = settled.account_context.as_ref().unwrap();
    assert_eq!(settled_ctx.active, Some(submitted.id.clone()));
    assert_eq!(
        settled.accounts.as_ref().unwrap().active,
        Some(submitted.id)
    );
    assert_ne!(settled_ctx.active, account.active);
    assert!(settled.accounts_error.is_none());
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submitting_cancel_reports_failed_code_and_restored_active_account() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();

    let (submitting_tx, submitting_rx) = mpsc::channel();
    let (release_fail_tx, release_fail_rx) = mpsc::channel();
    let release_fail_rx = Arc::new(Mutex::new(release_fail_rx));

    backend.set_begin_hook(move |mock, cancel| {
        let inner = mock.begin_add_account(cancel)?;
        let release_rx = release_fail_rx.clone();
        Ok(GateLoginFlow::wrap(
            inner,
            move |inner, _code, _cancel| {
                submitting_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(TEST_TIMEOUT)
                    .unwrap();
                // Dropping `inner` rolls the mock credential slot back to the previous account.
                drop(inner);
                Err(Error::new(ErrorKind::LoginInvalidCode))
            },
            |inner| inner.cancel(),
        ))
    });

    let (_, begin_job) = started(state.begin_login(account.clone()).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    let (_, submit_job) = started(state.submit_login(prompt.id, "bad-code".into()).unwrap());
    submitting_rx.recv_timeout(TEST_TIMEOUT).unwrap();

    let cancel_task = {
        let state = state.clone();
        tokio::spawn(async move { state.cancel_login_settled(prompt.id).await })
    };
    sleep(Duration::from_millis(60)).await;
    assert!(!cancel_task.is_finished());

    release_fail_tx.send(()).unwrap();
    let settled = timeout(TEST_TIMEOUT, cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        submit_job
            .await
            .unwrap()
            .unwrap_err()
            .is(ErrorKind::LoginInvalidCode)
    );

    let CancelLoginOutcome::SubmittingSettled(settled) = settled else {
        panic!("expected SubmittingSettled, got {settled:?}");
    };
    match settled.outcome {
        SubmitCancelOutcome::Failed(error) => assert!(error.is(ErrorKind::LoginInvalidCode)),
        other => panic!("expected Failed(LoginInvalidCode), got {other:?}"),
    }
    assert_eq!(
        settled.account_context.as_ref().unwrap().active,
        account.active
    );
    let accounts = settled.accounts.as_ref().unwrap();
    assert_eq!(accounts.active, account.active);
    assert!(accounts.has_token);
    assert!(settled.accounts_error.is_none());
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submitting_completed_and_failed_outcomes_survive_post_submit_accounts_refresh_error() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();

    // Case 1: submit commits a new account, then reading the account list fails.
    // The cancel waiter must still receive `Completed(account)` plus `accounts_error`.
    let (submitting_tx, submitting_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let backend_ref = backend.clone();
    backend.set_begin_hook(move |mock, cancel| {
        let inner = mock.begin_add_account(cancel)?;
        let release_rx = release_rx.clone();
        Ok(GateLoginFlow::wrap(
            inner,
            move |inner, code, _cancel| {
                submitting_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(TEST_TIMEOUT)
                    .unwrap();
                let saved = inner.submit_code(code, &CancelToken::new())?;
                backend_ref.fail_accounts_once.store(true, Ordering::SeqCst);
                Ok(saved)
            },
            |inner| inner.cancel(),
        ))
    });

    let (_, begin_job) = started(state.begin_login(account.clone()).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    let (_, submit_job) = started(state.submit_login(prompt.id, "4/0A-ok".into()).unwrap());
    submitting_rx.recv_timeout(TEST_TIMEOUT).unwrap();
    let cancel_task = {
        let state = state.clone();
        tokio::spawn(async move { state.cancel_login_settled(prompt.id).await })
    };
    sleep(Duration::from_millis(40)).await;
    release_tx.send(()).unwrap();

    let saved = submit_job.await.unwrap().unwrap().unwrap();
    let CancelLoginOutcome::SubmittingSettled(settled) = timeout(TEST_TIMEOUT, cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("expected SubmittingSettled");
    };
    assert_eq!(settled.outcome, SubmitCancelOutcome::Completed(saved));
    assert!(settled.account_context.is_none());
    assert!(settled.accounts.is_none());
    assert_eq!(settled.accounts_error, Some(ErrorKind::KeyringUnavailable));

    // Recover snapshot accounts before Case 2.
    let refreshed = state.refresh_accounts().await.unwrap();
    let current_ctx = refreshed.account.clone();

    // Case 2: submit fails with `LoginInvalidCode`, then reading the account list also fails.
    // The cancel waiter must preserve the original `LoginInvalidCode` error plus `accounts_error`.
    let (submitting_tx, submitting_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let backend_ref = backend.clone();
    backend.set_begin_hook(move |mock, cancel| {
        let inner = mock.begin_add_account(cancel)?;
        let release_rx = release_rx.clone();
        Ok(GateLoginFlow::wrap(
            inner,
            move |inner, _code, _cancel| {
                submitting_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(TEST_TIMEOUT)
                    .unwrap();
                drop(inner);
                backend_ref.fail_accounts_once.store(true, Ordering::SeqCst);
                Err(Error::new(ErrorKind::LoginInvalidCode))
            },
            |inner| inner.cancel(),
        ))
    });

    let (_, begin_job) = started(state.begin_login(current_ctx).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    let (_, submit_job) = started(state.submit_login(prompt.id, "bad".into()).unwrap());
    submitting_rx.recv_timeout(TEST_TIMEOUT).unwrap();
    let cancel_task = {
        let state = state.clone();
        tokio::spawn(async move { state.cancel_login_settled(prompt.id).await })
    };
    sleep(Duration::from_millis(40)).await;
    release_tx.send(()).unwrap();

    assert!(
        submit_job
            .await
            .unwrap()
            .unwrap_err()
            .is(ErrorKind::LoginInvalidCode)
    );
    let CancelLoginOutcome::SubmittingSettled(settled) = timeout(TEST_TIMEOUT, cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("expected SubmittingSettled");
    };
    match settled.outcome {
        SubmitCancelOutcome::Failed(error) => assert!(error.is(ErrorKind::LoginInvalidCode)),
        other => panic!("expected Failed(LoginInvalidCode), got {other:?}"),
    }
    assert!(settled.account_context.is_none());
    assert!(settled.accounts.is_none());
    assert_eq!(settled.accounts_error, Some(ErrorKind::KeyringUnavailable));
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_and_post_cancel_account_verification_failures_surface_as_errors() {
    let backend = demo_backend();
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;
    let account = initial.account.clone();

    // Case 1: code-phase cancel fails rollback -> error is propagated, never hidden.
    backend.set_begin_hook(move |mock, cancel| {
        let inner = mock.begin_add_account(cancel)?;
        Ok(GateLoginFlow::wrap(
            inner,
            |inner, code, cancel| inner.submit_code(code, cancel),
            |inner| {
                drop(inner);
                Err(Error::new(ErrorKind::KeyringUnavailable))
            },
        ))
    });
    let (_, begin_job) = started(state.begin_login(account.clone()).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    let err = state.cancel_login_settled(prompt.id).await.unwrap_err();
    assert!(err.is(ErrorKind::KeyringUnavailable));
    assert!(state.snapshot().login_id.is_none());

    // Case 2: submitting cancel succeeds in core, but verifying slot state fails -> error surfaces.
    backend.clear_begin_hook();
    let (submitting_tx, submitting_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let backend_for_hook = backend.clone();
    backend.set_begin_hook(move |mock, cancel| {
        let inner = mock.begin_add_account(cancel)?;
        let release_rx = release_rx.clone();
        let backend_ref = backend_for_hook.clone();
        Ok(GateLoginFlow::wrap(
            inner,
            move |inner, _code, cancel| {
                submitting_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(TEST_TIMEOUT)
                    .unwrap();
                assert!(cancel.is_cancelled());
                inner.cancel()?;
                backend_ref.fail_accounts_once.store(true, Ordering::SeqCst);
                Err(Error::cancelled())
            },
            |inner| inner.cancel(),
        ))
    });

    let (_, begin_job) = started(state.begin_login(account).unwrap());
    let prompt = begin_job.await.unwrap().unwrap();
    let (_, submit_job) = started(state.submit_login(prompt.id, "4/0A-err".into()).unwrap());
    submitting_rx.recv_timeout(TEST_TIMEOUT).unwrap();

    let cancel_task = {
        let state = state.clone();
        tokio::spawn(async move { state.cancel_login_settled(prompt.id).await })
    };
    sleep(Duration::from_millis(40)).await;
    release_tx.send(()).unwrap();
    let err = timeout(TEST_TIMEOUT, cancel_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(err.is(ErrorKind::KeyringUnavailable));
    assert!(
        submit_job
            .await
            .unwrap()
            .unwrap_err()
            .is(ErrorKind::Cancelled)
    );
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovered_pending_add_latches_across_polls_until_explicitly_dismissed() {
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.failures = MockFailures {
        interrupted_add: true,
        ..Default::default()
    };
    let backend = ControlledBackend::new(MockBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_ready(&state).await;

    // Startup recovery rolls back the interrupted add and latches `recovered_pending_add`.
    let initial_accounts = initial.accounts.as_ref().unwrap();
    assert!(initial_accounts.recovered_pending_add);
    assert!(initial_accounts.active.is_some());
    assert!(initial_accounts.has_token);

    // Core itself only reports `recovered_pending_add = true` once; confirm subsequent polls
    // from the backend return `false`, yet WebState keeps the latched flag `true`.
    assert!(
        !backend
            .inner
            .accounts(&CancelToken::new())
            .unwrap()
            .recovered_pending_add
    );
    for _ in 0..3 {
        let refreshed = state.refresh_accounts().await.unwrap();
        assert!(
            refreshed.accounts.as_ref().unwrap().recovered_pending_add,
            "subsequent account refreshes must not overwrite latched recovered_pending_add"
        );
    }
    assert!(backend.accounts_calls.load(Ordering::SeqCst) >= 4);

    // Explicitly dismissing clears the latch and publishes a new snapshot version.
    let before_dismiss = state.snapshot().version;
    state.dismiss_recovered_pending_add();
    let dismissed = state.snapshot();
    assert!(dismissed.version > before_dismiss);
    assert!(!dismissed.accounts.as_ref().unwrap().recovered_pending_add);

    // Dismissing again is an idempotent no-op, and future polls keep it false.
    let version_after_dismiss = dismissed.version;
    state.dismiss_recovered_pending_add();
    assert_eq!(state.snapshot().version, version_after_dismiss);
    let after_refresh = state.refresh_accounts().await.unwrap();
    assert!(
        !after_refresh
            .accounts
            .as_ref()
            .unwrap()
            .recovered_pending_add
    );
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn pick_isolated_port() -> u16 {
    for port in 18120..=18139 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            drop(listener);
            return port;
        }
    }
    0
}

fn spawn_mock_server(dir: &Path, access_key: &str) -> (Server, String, String) {
    let auth_dir = dir.join("web-auth");
    std::fs::create_dir_all(&auth_dir).unwrap();
    let hash: [u8; 32] = Sha256::digest(access_key.as_bytes()).into();
    std::fs::write(auth_dir.join("access-key.sha256"), hash).unwrap();

    let port = pick_isolated_port();
    let mut command = Command::new(env!("CARGO_BIN_EXE_colab-playground-web"));
    command
        .env("COLAB_PLAYGROUND_CONFIG_DIR", dir)
        .env_remove("COLAB_PLAYGROUND_BACKEND")
        .args(["--mock", "--no-open", "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut server = Server(command.spawn().unwrap());
    let mut stderr = BufReader::new(server.0.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    let addr = line
        .strip_prefix("Web Server listening on ")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("unexpected startup line: {line:?}"))
        .to_owned();
    (server, addr.clone(), format!("http://{addr}"))
}

#[test]
fn http_cancel_login_routes_and_dismiss_recovered_end_to_end() {
    use ureq::{
        Agent,
        http::{Request, StatusCode},
    };

    let dir = tempfile::tempdir().unwrap();
    let key = "login-cancel-http-test-key";
    let (_server, addr, origin) = spawn_mock_server(dir.path(), key);
    let agent: Agent = Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();

    let send = |method: &str, path: &str, auth: Option<&str>, body: Option<&str>| {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{origin}{path}"))
            .header("Origin", origin.as_str());
        if let Some(token) = auth {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        let payload = if let Some(json) = body {
            req = req.header("Content-Type", "application/json");
            json.to_owned()
        } else {
            String::new()
        };
        let mut resp = agent.run(req.body(payload).unwrap()).unwrap();
        let status = resp.status();
        let text = resp.body_mut().read_to_string().unwrap();
        let value: Option<serde_json::Value> = if text.is_empty() {
            None
        } else {
            Some(serde_json::from_str(&text).unwrap())
        };
        (status, value)
    };

    let (st, cred) = send(
        "POST",
        "/api/login",
        None,
        Some(&serde_json::json!({ "access_key": key }).to_string()),
    );
    assert_eq!(st, StatusCode::OK);
    let token = cred.unwrap()["token"].as_str().unwrap().to_owned();

    // Wait for initial mock accounts snapshot.
    let mut accounts = None;
    for _ in 0..60 {
        let (st, body) = send("GET", "/api/accounts", Some(&token), None);
        if st == StatusCode::OK {
            accounts = body;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let accounts = accounts.expect("initial mock accounts ready");
    let ctx = accounts["account_context"].clone();

    // 1. `POST /api/accounts/recovered/dismiss` succeeds idempotently with 204.
    let (st, _) = send(
        "POST",
        "/api/accounts/recovered/dismiss",
        Some(&token),
        Some("{}"),
    );
    assert_eq!(st, StatusCode::NO_CONTENT);

    // 2. Dropping the client connection mid-`POST /api/accounts/login` cancels only that
    //    request's own login start and leaves no 5-minute PendingLogin lock behind.
    {
        let body = serde_json::json!({ "account_context": ctx }).to_string();
        let mut stream = TcpStream::connect(&addr).unwrap();
        let req = format!(
            "POST /api/accounts/login HTTP/1.1\r\n\
             Host: {addr}\r\n\
             Origin: {origin}\r\n\
             Authorization: Bearer {token}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).unwrap();
        stream.flush().unwrap();
        std::thread::sleep(Duration::from_millis(50));
    }

    let mut prompt = None;
    for _ in 0..40 {
        let (st, body) = send(
            "POST",
            "/api/accounts/login",
            Some(&token),
            Some(&serde_json::json!({ "account_context": ctx }).to_string()),
        );
        if st == StatusCode::CREATED {
            prompt = body;
            break;
        }
        assert_eq!(st, StatusCode::CONFLICT, "unexpected body: {body:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let prompt = prompt.expect("aborted begin_login released the exclusive lock");
    let login_id = prompt["id"].as_u64().unwrap();

    // 3. Unscoped `DELETE /api/accounts/login` is rejected so stale tabs cannot cancel another
    //    tab's login; scoped `DELETE /api/accounts/login/{id}` cancels only its matching login.
    let (st, _) = send("DELETE", "/api/accounts/login", Some(&token), Some("{}"));
    assert_eq!(st, StatusCode::METHOD_NOT_ALLOWED);

    let (st, _) = send(
        "DELETE",
        &format!("/api/accounts/login/{login_id}"),
        Some(&token),
        Some("{}"),
    );
    assert_eq!(st, StatusCode::NO_CONTENT);

    // Cancelling the already-cancelled id reports login_cancelled (409).
    let (st, err) = send(
        "DELETE",
        &format!("/api/accounts/login/{login_id}"),
        Some(&token),
        Some("{}"),
    );
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(
        err.unwrap()["error"]["kind"].as_str(),
        Some("login_cancelled")
    );

    // 4. `DELETE /api/accounts/login/{id}` during submitting NEVER returns 202 Accepted.
    let (st, prompt) = send(
        "POST",
        "/api/accounts/login",
        Some(&token),
        Some(&serde_json::json!({ "account_context": ctx }).to_string()),
    );
    assert_eq!(st, StatusCode::CREATED);
    let login_id = prompt.unwrap()["id"].as_u64().unwrap();

    let submit_handle = {
        let origin = origin.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            let agent: Agent = Agent::config_builder()
                .proxy(None)
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(10)))
                .build()
                .into();
            let req = Request::builder()
                .method("POST")
                .uri(format!("{origin}/api/accounts/login/{login_id}"))
                .header("Origin", origin.as_str())
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(serde_json::json!({ "code": "4/0A-http-race" }).to_string())
                .unwrap();
            let mut resp = agent.run(req).unwrap();
            (resp.status(), resp.body_mut().read_to_string().unwrap())
        })
    };

    for _ in 0..40 {
        let (st, snap) = send("GET", "/api/snapshot", Some(&token), None);
        if st == StatusCode::OK {
            let snap = snap.unwrap();
            let submitting = snap["operations"].as_array().is_some_and(|ops| {
                ops.iter().any(|op| {
                    op["operation"]["kind"].as_str() == Some("login")
                        && op["operation"]["login_id"].as_u64() == Some(login_id)
                })
            });
            if submitting {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let (cancel_st, cancel_body) = send(
        "DELETE",
        &format!("/api/accounts/login/{login_id}"),
        Some(&token),
        Some("{}"),
    );
    assert_ne!(
        cancel_st,
        StatusCode::ACCEPTED,
        "submitting cancel must never return 202 Accepted"
    );
    let (submit_st, _submit_body) = submit_handle.join().unwrap();
    if cancel_st == StatusCode::OK {
        let body = cancel_body.expect("settled JSON body");
        let outcome = body["outcome"].as_str().unwrap();
        assert!(matches!(outcome, "cancelled" | "completed" | "failed"));
        assert!(body["account_context"].is_object());
        assert!(body["accounts"].is_object());
        if outcome == "cancelled" {
            assert_eq!(submit_st, StatusCode::CONFLICT);
        } else if outcome == "completed" {
            assert_eq!(submit_st, StatusCode::OK);
            assert!(body["account"].is_object());
        }
    } else {
        assert_eq!(cancel_st, StatusCode::CONFLICT);
    }
}
