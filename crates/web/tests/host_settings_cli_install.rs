use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, SystemTime},
};

use colab_playground_core::{
    CancelToken, Defaults, Error, ErrorKind, Result,
    accounts::{Account, AccountId, AccountsView},
    backend::*,
    hf::HfModel,
    host::{Line, ProbeReport, Stream},
    mock::{MockBackend, MockConfig, MockFailures, MockScenario},
    plugins::{PluginInfo, PluginPreview},
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    quant::GgufListing,
    sessions::{HardwareRate, WatchdogInfo},
    tunnel::{TunnelEvent, TunnelId, TunnelInfo, TunnelSpec},
};
use colab_playground_web::state::{
    Access, CliInstallEvent, CliInstallPhase, CliInstallStart, SettingsNotice, Submission, WebState,
};
use tokio::time::timeout;

const TEST_TIMEOUT: Duration = Duration::from_secs(8);

struct ProbeBarrierBackend {
    mock: MockBackend,
    hold_next_probe: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    probe_error: Mutex<Option<Error>>,
    extra_install_lines: AtomicUsize,
}

impl ProbeBarrierBackend {
    fn new(config: MockConfig) -> Self {
        Self {
            mock: MockBackend::new(config),
            hold_next_probe: Mutex::new(None),
            probe_error: Mutex::new(None),
            extra_install_lines: AtomicUsize::new(0),
        }
    }

    fn arm_probe_barrier(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *self.hold_next_probe.lock().unwrap() = Some((entered_tx, release_rx));
        (entered_rx, release_tx)
    }

    fn set_probe_error(&self, error: Option<Error>) {
        *self.probe_error.lock().unwrap() = error;
    }
}

macro_rules! delegate_backend {
    ($(fn $name:ident($($arg:ident: $ty:ty),*) $(-> $ret:ty)?;)*) => {
        $(fn $name(&self, $($arg: $ty),*) $(-> $ret)? {
            self.mock.$name($($arg),*)
        })*
    };
}

impl Backend for ProbeBarrierBackend {
    delegate_backend! {
        fn kind() -> BackendKind;
        fn defaults() -> Defaults;
        fn set_defaults(defaults: Defaults);
        fn now() -> SystemTime;
        fn accounts(cancel: &CancelToken) -> Result<AccountsView>;
        fn adopt_active_account(cancel: &CancelToken) -> Result<Account>;
        fn begin_add_account(cancel: &CancelToken) -> Result<Box<dyn LoginFlow>>;
        fn switch_impact(to: &AccountId) -> Result<SwitchImpact>;
        fn switch_account(to: &AccountId, cancel: &CancelToken) -> Result<AccountsView>;
        fn remove_account(id: &AccountId, cancel: &CancelToken) -> Result<()>;
        fn refresh_usage(accounts: &[AccountId], cancel: &CancelToken) -> Result<Vec<AccountUsageView>>;
        fn usage() -> Vec<AccountUsageView>;
        fn usage_poll_due() -> bool;
        fn measured_rates() -> Vec<HardwareRate>;
        fn runtimes(cancel: &CancelToken) -> Result<RuntimesView>;
        fn new_session_name(prefix: Option<&str>) -> String;
        fn provision(spec: ProvisionSpec, events: Events<ProvisionEvent>, cancel: &CancelToken) -> Result<ProvisionOutcome>;
        fn stop_session(target: &RuntimeRef, options: StopOptions, cancel: &CancelToken) -> Result<()>;
        fn extend_session(target: &RuntimeRef, by: Duration, cancel: &CancelToken) -> Result<Extension>;
        fn set_auto_stop(target: &RuntimeRef, runtime: Duration, cancel: &CancelToken) -> Result<WatchdogInfo>;
        fn cancel_auto_stop(target: &RuntimeRef, cancel: &CancelToken) -> Result<()>;
        fn guard_poll(cancel: &CancelToken) -> Result<GuardReport>;
        fn open_tunnel(spec: TunnelSpec, events: Events<TunnelEvent>) -> Result<TunnelId>;
        fn close_tunnel(id: TunnelId) -> Result<()>;
        fn tunnels() -> Vec<TunnelInfo>;
        fn plugins() -> Vec<PluginInfo>;
        fn plugin_run_template(plugin: &str) -> Result<PluginRunSpec>;
        fn inspect_plugin_folder(path: &Path) -> Result<PluginPreview>;
        fn inspect_plugin_git(url: &str, cancel: &CancelToken) -> Result<PluginPreview>;
        fn install_plugin(preview: &PluginPreview) -> Result<PluginInfo>;
        fn discard_plugin_preview(preview: &PluginPreview);
        fn set_plugin_enabled(id: &str, enabled: bool) -> Result<()>;
        fn remove_plugin(id: &str) -> Result<()>;
        fn run_plugin(spec: PluginRunSpec, events: Events<PluginRunEvent>, cancel: &CancelToken) -> Result<PluginRunOutcome>;
        fn set_secret(name: &str, value: &str, cancel: &CancelToken) -> Result<()>;
        fn has_secret(name: &str, cancel: &CancelToken) -> Result<bool>;
        fn delete_secret(name: &str, cancel: &CancelToken) -> Result<()>;
        fn hf_search(query: &str, limit: u32, cancel: &CancelToken) -> Result<Vec<HfModel>>;
        fn hf_files(repo: &str, cancel: &CancelToken) -> Result<GgufListing>;
    }

    fn probe(&self, cancel: &CancelToken) -> Result<ProbeReport> {
        let barrier = self.hold_next_probe.lock().unwrap().take();
        if let Some((entered, release)) = barrier {
            let _ = entered.send(());
            let _ = release.recv_timeout(TEST_TIMEOUT);
        }
        if let Some(error) = self.probe_error.lock().unwrap().clone() {
            return Err(error);
        }
        self.mock.probe(cancel)
    }

    fn install_cli(
        &self,
        method: InstallMethod,
        log: Events<Line>,
        cancel: &CancelToken,
    ) -> Result<()> {
        let extra = self.extra_install_lines.load(Ordering::SeqCst);
        if extra > 0 {
            for ix in 0..extra {
                cancel.check()?;
                let _ = log.send(Line {
                    stream: Stream::Stdout,
                    text: format!("line-{ix}"),
                });
            }
            self.mock.set_failures(MockFailures::default());
            return Ok(());
        }
        self.mock.install_cli(method, log, cancel)
    }
}

async fn drain_install(
    events: &mut colab_playground_web::state::CliInstallEvents,
) -> (
    u64,
    InstallMethod,
    Vec<Line>,
    colab_playground_web::state::CliInstallOutcome,
) {
    let Some(CliInstallEvent::Started { id, method }) =
        timeout(TEST_TIMEOUT, events.next()).await.unwrap()
    else {
        panic!("expected started event");
    };
    let mut lines = Vec::new();
    let outcome = loop {
        match timeout(TEST_TIMEOUT, events.next()).await.unwrap() {
            Some(CliInstallEvent::Line(line)) => lines.push(line),
            Some(CliInstallEvent::Finished(outcome)) => break outcome,
            other => panic!("unexpected install event: {other:?}"),
        }
    };
    assert!(
        timeout(TEST_TIMEOUT, events.next())
            .await
            .unwrap()
            .is_none()
    );
    (id, method, lines, outcome)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_install_buffers_logs_and_replays_across_disconnect_and_completion() {
    let mut config = MockConfig::interactive(Duration::from_millis(80));
    config.failures.cli_missing = true;
    let backend = Arc::new(MockBackend::new(config));
    let state = WebState::start(backend).await.unwrap();

    let CliInstallStart::Started { id, mut events } =
        state.start_cli_install(InstallMethod::Uv).unwrap()
    else {
        panic!("expected install to start");
    };
    let Some(CliInstallEvent::Started { id: started_id, .. }) =
        timeout(TEST_TIMEOUT, events.next()).await.unwrap()
    else {
        panic!("expected started");
    };
    assert_eq!(started_id, id);
    let Some(CliInstallEvent::Line(first_line)) =
        timeout(TEST_TIMEOUT, events.next()).await.unwrap()
    else {
        panic!("expected first line");
    };
    // Simulate client disconnect mid-install.
    drop(events);

    let mut reconnected = state.subscribe_cli_install(Some(id)).unwrap();
    let (replayed_id, method, lines, outcome) = drain_install(&mut reconnected).await;
    assert_eq!(replayed_id, id);
    assert_eq!(method, InstallMethod::Uv);
    assert_eq!(lines.len(), 5);
    assert_eq!(lines[0], first_line);
    assert_eq!(outcome.phase, CliInstallPhase::Succeeded);
    assert!(outcome.cli_installed);
    assert!(outcome.error.is_none());

    // Reconnecting after completion still replays the full log and terminal outcome.
    let mut post_finish = state.subscribe_cli_install(None).unwrap();
    let (post_id, post_method, post_lines, post_outcome) = drain_install(&mut post_finish).await;
    assert_eq!(post_id, id);
    assert_eq!(post_method, InstallMethod::Uv);
    assert_eq!(post_lines, lines);
    assert_eq!(post_outcome.phase, CliInstallPhase::Succeeded);

    let snapshot = state.cli_install_snapshot();
    assert_eq!(snapshot.id, Some(id));
    assert_eq!(snapshot.phase, CliInstallPhase::Succeeded);
    assert_eq!(snapshot.lines, lines);

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_install_retains_and_replays_over_2000_lines_losslessly() {
    let (mut config, _) = MockConfig::headless(MockScenario::signed_out());
    config.failures.cli_missing = true;
    let backend = Arc::new(ProbeBarrierBackend::new(config));
    let total_lines = 2_050;
    backend
        .extra_install_lines
        .store(total_lines, Ordering::SeqCst);
    let state = WebState::start(backend).await.unwrap();

    let CliInstallStart::Started { id, mut events } =
        state.start_cli_install(InstallMethod::PipUser).unwrap()
    else {
        panic!("expected install to start");
    };
    let (_, _, _, outcome) = drain_install(&mut events).await;
    assert_eq!(outcome.phase, CliInstallPhase::Succeeded);

    let snap = state.cli_install_snapshot();
    assert_eq!(snap.id, Some(id));
    assert_eq!(snap.lines.len(), total_lines);
    assert_eq!(snap.lines.first().unwrap().text, "line-0");
    assert_eq!(
        snap.lines.last().unwrap().text,
        format!("line-{}", total_lines - 1)
    );
    assert_eq!(state.snapshot().cli_install.line_count, total_lines);

    let mut replay = state.subscribe_cli_install(Some(id)).unwrap();
    let (_, _, replayed_lines, _) = drain_install(&mut replay).await;
    assert_eq!(replayed_lines.len(), total_lines);
    assert_eq!(replayed_lines, snap.lines);

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_install_off_path_and_probe_error_preserve_distinct_phases_and_recheck() {
    let (mut config, _) = MockConfig::headless(MockScenario::signed_out());
    config.failures.cli_missing = true;
    config.failures.install_off_path = true;
    let backend = Arc::new(ProbeBarrierBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();

    let (entered_post_probe, release_post_probe) = backend.arm_probe_barrier();
    let CliInstallStart::Started { id, mut events } =
        state.start_cli_install(InstallMethod::Uv).unwrap()
    else {
        panic!("expected install to start");
    };

    // Wait until installer exits 0 and post-install probe begins.
    tokio::task::spawn_blocking(move || entered_post_probe.recv_timeout(TEST_TIMEOUT).unwrap())
        .await
        .unwrap();
    assert_eq!(
        state.snapshot().cli_install.phase,
        CliInstallPhase::Checking
    );
    assert_eq!(
        state.cli_install_snapshot().phase,
        CliInstallPhase::Checking
    );
    release_post_probe.send(()).unwrap();

    let (finished_id, _, lines, outcome) = drain_install(&mut events).await;
    assert_eq!(finished_id, id);
    assert_eq!(outcome.phase, CliInstallPhase::NotFound);
    assert!(!outcome.cli_installed);
    assert!(outcome.error.is_none());
    assert!(
        lines
            .iter()
            .any(|line| line.stream == Stream::Stderr && line.text.contains("not on your PATH"))
    );
    assert_eq!(
        state.snapshot().cli_install.phase,
        CliInstallPhase::NotFound
    );

    // Check again while colab is still missing: enters Checking, blocks host rebuilds, then returns to NotFound.
    let (entered_recheck, release_recheck) = backend.arm_probe_barrier();
    let probe_state = state.clone();
    let probe_task =
        tokio::spawn(async move { probe_state.probe_environment_with(|| "distro-a").await });
    tokio::task::spawn_blocking(move || entered_recheck.recv_timeout(TEST_TIMEOUT).unwrap())
        .await
        .unwrap();
    assert_eq!(
        state.snapshot().cli_install.phase,
        CliInstallPhase::Checking
    );
    assert_eq!(
        state
            .apply_host_change(|_, _| Ok(()))
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Busy
    );
    release_recheck.send(()).unwrap();

    let (report, snapshot, cli_install, _, meta) = probe_task.await.unwrap().unwrap();
    assert!(report.colab.is_none());
    assert_eq!(meta, "distro-a");
    assert_eq!(snapshot.cli_install.phase, CliInstallPhase::NotFound);
    assert_eq!(cli_install.phase, CliInstallPhase::NotFound);
    assert_eq!(cli_install.lines, lines);

    // Post-install probe returning a real error (e.g. non-executable custom colab_path) reports
    // ProbeFailed rather than NotFound.
    backend.set_probe_error(Some(Error::invalid("colab_path", "not executable")));
    let CliInstallStart::Started { mut events, .. } =
        state.start_cli_install(InstallMethod::Uv).unwrap()
    else {
        panic!("expected install to start");
    };
    let (_, _, _, probe_err_outcome) = drain_install(&mut events).await;
    assert_eq!(probe_err_outcome.phase, CliInstallPhase::ProbeFailed);
    assert!(!probe_err_outcome.cli_installed);
    assert_eq!(
        probe_err_outcome.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::InvalidInput)
    );
    assert_eq!(
        state.snapshot().cli_install.phase,
        CliInstallPhase::ProbeFailed
    );

    // Once the probe error and missing CLI are resolved, Check again settles to Succeeded.
    backend.set_probe_error(None);
    backend.mock.set_failures(MockFailures::default());
    let (report, snapshot, _) = state.probe_environment().await.unwrap();
    assert!(report.colab.is_some());
    assert_eq!(snapshot.cli_install.phase, CliInstallPhase::Succeeded);

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_change_blocks_independent_writes_rebuilds_backend_closes_tunnels_and_clears_install()
{
    let (mut old_config, _) = MockConfig::headless(MockScenario::demo());
    old_config.failures.cli_missing = false;
    let old_backend = Arc::new(MockBackend::new(old_config));
    let state = WebState::start(old_backend.clone()).await.unwrap();
    timeout(
        TEST_TIMEOUT,
        state
            .subscribe()
            .wait_for(|snapshot| snapshot.runtimes.is_some()),
    )
    .await
    .unwrap()
    .unwrap();

    let before = state.snapshot();
    let active = before.account.active.clone().unwrap();
    let session = before
        .runtimes
        .as_ref()
        .unwrap()
        .runtimes
        .iter()
        .find_map(|runtime| {
            (runtime.id.account == active)
                .then_some(runtime.id.name.as_ref())
                .flatten()
        })
        .unwrap()
        .clone();
    let spec = TunnelSpec {
        account: active,
        session,
        bind: Default::default(),
        local_port: 18305,
        remote_port: 8000,
        health_path: None,
    };
    let Submission::Started { job, .. } = state.open_forward(before.account.clone(), spec).unwrap()
    else {
        panic!("expected forward to open");
    };
    job.await.unwrap().unwrap();
    assert_eq!(old_backend.tunnels().len(), 1);
    assert_eq!(state.snapshot().tunnels.len(), 1);

    // Seed an off-path install and a startup settings notice.
    old_backend.set_failures(MockFailures {
        cli_missing: true,
        install_off_path: true,
        ..Default::default()
    });
    let CliInstallStart::Started { mut events, .. } =
        state.start_cli_install(InstallMethod::Uv).unwrap()
    else {
        panic!("expected install to start");
    };
    let (_, _, _, outcome) = drain_install(&mut events).await;
    assert_eq!(outcome.phase, CliInstallPhase::NotFound);

    state.set_settings_notice(Some(SettingsNotice {
        corrupt: true,
        corrupt_backup: Some("settings.json.bak".into()),
        reset_defaults: Vec::new(),
    }));
    assert!(state.snapshot().settings_notice.is_some());

    // Busy check: a running independent operation blocks host rebuilds.
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let Submission::Started { job: blocker, .. } = state
        .start_operation(
            "busy_op",
            String::new(),
            Access::Independent,
            move |_, _| {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(TEST_TIMEOUT);
                Ok(())
            },
        )
        .unwrap()
    else {
        panic!("expected blocker to start");
    };
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(TEST_TIMEOUT).unwrap())
        .await
        .unwrap();
    assert!(!state.can_change_host());
    assert_eq!(
        state
            .apply_host_change(|_, _| Ok(()))
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Busy
    );
    release_tx.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    assert!(state.can_change_host());

    // While a host rebuild is in progress, independent writes (such as plugin mutations) are
    // rejected with Busy so they cannot mutate the old backend after the new one was initialized.
    let (rebuild_entered_tx, rebuild_entered_rx) = mpsc::channel();
    let (rebuild_release_tx, rebuild_release_rx) = mpsc::channel();
    let rebuild_state = state.clone();
    let old_revision = state.snapshot().account.revision;
    let (new_config, _) = MockConfig::headless(MockScenario::single());
    let new_backend = Arc::new(MockBackend::new(new_config));
    let swap_target: Arc<dyn Backend> = new_backend.clone();
    let rebuild_task = tokio::spawn(async move {
        rebuild_state
            .apply_host_change(move |commit, _| {
                let _ = rebuild_entered_tx.send(());
                let _ = rebuild_release_rx.recv_timeout(TEST_TIMEOUT);
                commit.commit_host_change(Some(swap_target), Defaults::default());
                Ok(())
            })
            .await
    });
    tokio::task::spawn_blocking(move || rebuild_entered_rx.recv_timeout(TEST_TIMEOUT).unwrap())
        .await
        .unwrap();
    assert_eq!(
        state
            .enable_plugin("llama-cpp".into(), false)
            .err()
            .map(|error| error.kind),
        Some(ErrorKind::Busy)
    );
    assert_eq!(
        state.run_backend(|_, _| Ok(())).await.unwrap_err().kind,
        ErrorKind::Busy
    );
    rebuild_release_tx.send(()).unwrap();
    rebuild_task.await.unwrap().unwrap();

    assert!(old_backend.tunnels().is_empty());
    assert!(state.snapshot().tunnels.is_empty());
    assert_eq!(state.snapshot().cli_install.phase, CliInstallPhase::Idle);
    assert!(state.cli_install_snapshot().lines.is_empty());
    assert!(state.subscribe_cli_install(None).is_none());
    assert!(state.snapshot().settings_notice.is_none());
    assert!(state.snapshot().account.revision > old_revision);

    // Post-rebuild probe populates state from the new backend (single scenario has 1 account).
    timeout(
        TEST_TIMEOUT,
        state.subscribe().wait_for(|snapshot| {
            snapshot
                .accounts
                .as_ref()
                .is_some_and(|view| view.accounts.len() == 1)
        }),
    )
    .await
    .unwrap()
    .unwrap();
    let (report, _, _) = state.probe_environment().await.unwrap();
    assert!(report.colab.is_some());

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}
