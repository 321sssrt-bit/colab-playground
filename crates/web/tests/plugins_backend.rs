use std::{
    collections::BTreeMap,
    io::{BufRead as _, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime},
};

use colab_playground_core::{
    CancelToken, Error, ErrorKind, Result,
    accounts::{Account, AccountId, AccountsView},
    backend::{
        AccountUsageView, Backend, BackendKind, Events, Extension, GuardReport, InstallMethod,
        LoginFlow, PluginRunEvent, PluginRunOutcome, PluginRunSpec, RunTarget, RuntimeRef,
        RuntimesView, StopOptions, SwitchImpact,
    },
    defaults::Defaults,
    hf::HfModel,
    host::{Line, ProbeReport},
    mock::{MockBackend, MockConfig, MockScenario},
    plugins::{
        InputValue, Manifest, PluginInfo, PluginOrigin, PluginPreview, bundled, discard_preview,
    },
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    quant::{GgufFile, GgufListing, GgufVariant},
    sessions::{HardwareRate, WatchdogInfo},
    tunnel::{TunnelEvent, TunnelId, TunnelInfo, TunnelSpec},
    vm::{RunState, RunStatus},
};
use colab_playground_web::state::{
    AccountContext, Operation, Submission, WebState,
    plugins::{RUN_LOG_LINES_KEPT, RunEvent, RunPhase},
};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use ureq::{
    Agent,
    http::{Request, StatusCode},
};

enum RunBehavior {
    ChattyReady {
        total_lines: usize,
        pad_bytes: usize,
        extra_statuses: usize,
    },
    Fail(ErrorKind),
    HoldUntilCancelled {
        started: mpsc::Sender<()>,
    },
}

enum GitPreviewBehavior {
    BlockUntilCancelled {
        staging: PathBuf,
        started: mpsc::Sender<PathBuf>,
    },
    ReturnStagedAfterCancel {
        staging: PathBuf,
        started: mpsc::Sender<()>,
        proceed: Mutex<Option<mpsc::Receiver<()>>>,
    },
}

struct HfGate {
    started: mpsc::Sender<()>,
    release: Mutex<Option<mpsc::Receiver<()>>>,
}

struct TestBackend {
    inner: MockBackend,
    run_behavior: Mutex<Option<RunBehavior>>,
    git_behavior: Mutex<Option<GitPreviewBehavior>>,
    hf_calls: Arc<AtomicUsize>,
    hf_fail: Mutex<bool>,
    hf_version: AtomicUsize,
    hf_gate: Mutex<Option<HfGate>>,
    secret_gate: Mutex<Option<HfGate>>,
}

impl TestBackend {
    fn new() -> Self {
        Self {
            inner: MockBackend::new(MockConfig::headless(MockScenario::demo()).0),
            run_behavior: Mutex::new(None),
            git_behavior: Mutex::new(None),
            hf_calls: Arc::new(AtomicUsize::new(0)),
            hf_fail: Mutex::new(false),
            hf_version: AtomicUsize::new(1),
            hf_gate: Mutex::new(None),
            secret_gate: Mutex::new(None),
        }
    }

    fn set_run_behavior(&self, behavior: RunBehavior) {
        *self.run_behavior.lock().unwrap() = Some(behavior);
    }

    fn set_git_behavior(&self, behavior: GitPreviewBehavior) {
        *self.git_behavior.lock().unwrap() = Some(behavior);
    }
}

impl Backend for TestBackend {
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
        self.inner.accounts(cancel)
    }

    fn adopt_active_account(&self, cancel: &CancelToken) -> Result<Account> {
        self.inner.adopt_active_account(cancel)
    }

    fn begin_add_account(&self, cancel: &CancelToken) -> Result<Box<dyn LoginFlow>> {
        self.inner.begin_add_account(cancel)
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
        let behavior = self.git_behavior.lock().unwrap().take();
        match behavior {
            Some(GitPreviewBehavior::BlockUntilCancelled { staging, started }) => {
                let checkout = staging.join("git-test-checkout");
                std::fs::create_dir_all(checkout.join(".git"))?;
                std::fs::write(checkout.join("partial.tmp"), b"cloning")?;
                let _ = started.send(checkout.clone());

                let deadline = Instant::now() + Duration::from_secs(5);
                while !cancel.is_cancelled() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                let _ = std::fs::remove_dir_all(&checkout);
                if cancel.is_cancelled() {
                    Err(Error::cancelled())
                } else {
                    Err(Error::new(ErrorKind::Timeout))
                }
            }
            Some(GitPreviewBehavior::ReturnStagedAfterCancel {
                staging,
                started,
                proceed,
            }) => {
                let staged = staging.join("stage-test-preview");
                std::fs::create_dir_all(&staged)?;
                std::fs::write(staged.join("plugin.toml"), sample_manifest())?;
                std::fs::write(staged.join("worker.sh"), "#!/usr/bin/env bash\necho hi\n")?;
                let _ = started.send(());
                if let Some(rx) = proceed.lock().unwrap().take() {
                    let _ = rx.recv_timeout(Duration::from_secs(5));
                }
                Ok(PluginPreview {
                    manifest: Manifest::parse(sample_manifest())?,
                    origin: PluginOrigin::Git {
                        url: url.to_owned(),
                    },
                    script_bytes: 28,
                    replaces_version: None,
                    staged_dir: staged,
                })
            }
            None => self.inner.inspect_plugin_git(url, cancel),
        }
    }

    fn install_plugin(&self, preview: &PluginPreview) -> Result<PluginInfo> {
        self.inner.install_plugin(preview)
    }

    fn discard_plugin_preview(&self, preview: &PluginPreview) {
        discard_preview(preview);
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
        let behavior = self.run_behavior.lock().unwrap().take();
        let account = self
            .inner
            .accounts(&CancelToken::new())?
            .active
            .expect("mock active account");
        let session = match &spec.target {
            RunTarget::Existing { name } => name.clone(),
            RunTarget::Provision(p) => p.name.clone(),
        };
        match behavior {
            Some(RunBehavior::ChattyReady {
                total_lines,
                pad_bytes,
                extra_statuses,
            }) => {
                let _ = events.send(PluginRunEvent::Launched {
                    session: session.clone(),
                    run_id: "run-chatty".into(),
                });
                let _ = events.send(PluginRunEvent::Status(RunStatus {
                    state: RunState::Running,
                    stage: Some("download".into()),
                    progress: Some(0.5),
                    message: Some("downloading".into()),
                    ..Default::default()
                }));
                let pad = "x".repeat(pad_bytes);
                let make_line = |i: usize| {
                    if pad.is_empty() {
                        format!("line-{i}")
                    } else {
                        format!("line-{i}:{pad}")
                    }
                };
                // Mix a large batch with single-line log events to exercise both trim paths.
                let batch_count = total_lines.min(1_500);
                let batch: Vec<String> = (0..batch_count).map(make_line).collect();
                let _ = events.send(PluginRunEvent::Log { lines: batch });
                for i in batch_count..total_lines {
                    let _ = events.send(PluginRunEvent::Log {
                        lines: vec![make_line(i)],
                    });
                }
                for step in 0..extra_statuses {
                    let _ = events.send(PluginRunEvent::Status(RunStatus {
                        state: RunState::Running,
                        stage: Some("download".into()),
                        progress: Some(0.5),
                        message: Some(format!("status-{step}")),
                        ..Default::default()
                    }));
                }
                let status = RunStatus {
                    state: RunState::Ready,
                    stage: Some("serve".into()),
                    progress: Some(1.0),
                    message: Some("ready".into()),
                    ..Default::default()
                };
                let _ = events.send(PluginRunEvent::Status(status.clone()));
                Ok(PluginRunOutcome {
                    session,
                    account,
                    run_id: "run-chatty".into(),
                    status,
                    endpoints: Vec::new(),
                })
            }
            Some(RunBehavior::Fail(kind)) => {
                let _ = events.send(PluginRunEvent::Launched {
                    session,
                    run_id: "run-fail".into(),
                });
                Err(Error::new(kind))
            }
            Some(RunBehavior::HoldUntilCancelled { started }) => {
                let _ = events.send(PluginRunEvent::Launched {
                    session,
                    run_id: "run-cancel".into(),
                });
                let _ = started.send(());
                let deadline = Instant::now() + Duration::from_secs(5);
                while !cancel.is_cancelled() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(Error::cancelled())
            }
            None => self.inner.run_plugin(spec, events, cancel),
        }
    }

    fn set_secret(&self, name: &str, value: &str, cancel: &CancelToken) -> Result<()> {
        self.inner.set_secret(name, value, cancel)
    }

    fn has_secret(&self, name: &str, cancel: &CancelToken) -> Result<bool> {
        self.inner.has_secret(name, cancel)
    }

    fn delete_secret(&self, name: &str, cancel: &CancelToken) -> Result<()> {
        if let Some(gate) = self.secret_gate.lock().unwrap().take() {
            let _ = gate.started.send(());
            if let Some(rx) = gate.release.lock().unwrap().take() {
                let _ = rx.recv_timeout(Duration::from_secs(5));
            }
        }
        self.inner.delete_secret(name, cancel)
    }

    fn hf_search(&self, query: &str, limit: u32, cancel: &CancelToken) -> Result<Vec<HfModel>> {
        self.inner.hf_search(query, limit, cancel)
    }

    fn hf_files(&self, repo: &str, _cancel: &CancelToken) -> Result<GgufListing> {
        self.hf_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = self.hf_gate.lock().unwrap().take() {
            let _ = gate.started.send(());
            if let Some(rx) = gate.release.lock().unwrap().take() {
                let _ = rx.recv_timeout(Duration::from_secs(5));
            }
        }
        if *self.hf_fail.lock().unwrap() {
            return Err(Error::new(ErrorKind::Http));
        }
        let version = self.hf_version.load(Ordering::SeqCst) as u64;
        Ok(GgufListing {
            variants: vec![GgufVariant {
                quant: "Q4_K_M".into(),
                files: vec![format!("{repo}-v{version}.gguf")],
                size: 4_000_000_000 * version,
            }],
            mmproj: vec![GgufFile {
                path: "mmproj-F16.gguf".into(),
                size: 500_000_000,
            }],
        })
    }
}

fn sample_manifest() -> &'static str {
    r#"
api = 1
id = "git-cancel-demo"
version = "0.1.0"

[name]
en = "Git Cancel Demo"

[run]
script = "worker.sh"
"#
}

async fn ready_context(state: &WebState) -> (AccountContext, RuntimeRef, String) {
    let mut rx = state.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snap = rx.borrow_and_update().clone();
            if snap.accounts.is_some()
                && let Some(runtimes) = &snap.runtimes
                && let Some(managed) = runtimes
                    .runtimes
                    .iter()
                    .find(|r| r.managed && r.on_active_account && r.id.name.is_some())
            {
                return (
                    snap.account.clone(),
                    managed.id.clone(),
                    managed.id.name.clone().unwrap(),
                );
            }
            rx.changed().await.unwrap();
        }
    })
    .await
    .expect("mock snapshot ready")
}

fn existing_run_spec(session_name: String) -> PluginRunSpec {
    let mut inputs = BTreeMap::new();
    inputs.insert(
        "repo".into(),
        InputValue::Text("unsloth/Qwen3-0.6B-GGUF".into()),
    );
    inputs.insert("quant".into(), InputValue::Text("auto".into()));
    inputs.insert("ctx".into(), InputValue::Number(0.0));
    inputs.insert("port".into(), InputValue::Number(8000.0));
    PluginRunSpec {
        plugin: Manifest::parse(bundled()[0].0).unwrap().id,
        inputs,
        target: RunTarget::Existing { name: session_name },
        stop_on_failure: true,
    }
}

async fn wait_run_finished(state: &WebState, id: u64) -> RunPhase {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(summary) = state.plugin_runs().into_iter().find(|r| r.id == id)
                && summary.finished
            {
                return summary.phase;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("run finished")
}

#[tokio::test]
async fn run_log_keeps_newest_2000_lines_and_replays_on_reconnect() {
    let backend = Arc::new(TestBackend::new());
    let total_lines = RUN_LOG_LINES_KEPT + 350;
    backend.set_run_behavior(RunBehavior::ChattyReady {
        total_lines,
        pad_bytes: 0,
        extra_statuses: 0,
    });
    let state = WebState::start(backend.clone()).await.unwrap();
    let (account, runtime, session_name) = ready_context(&state).await;

    let run_id = state
        .start_plugin_run(
            account.clone(),
            existing_run_spec(session_name.clone()),
            Some(runtime.clone()),
        )
        .await
        .unwrap();
    assert_eq!(wait_run_finished(&state, run_id).await, RunPhase::Ready);

    // Subscribe after finish to verify full reconnect replay of the newest 2,000 log lines.
    let run = state.plugin_run(run_id).expect("run retained");
    let mut events = run.subscribe();
    let mut saw_history_skipped = false;
    let mut saw_launched = false;
    let mut saw_status = false;
    let mut saw_finished = false;
    let mut replayed_lines = Vec::new();

    while let Some(event) = events.next().await {
        match event {
            RunEvent::Progress { kind, data } => match kind {
                "history_skipped" => saw_history_skipped = true,
                "launched" => saw_launched = true,
                "status" => saw_status = true,
                "log" => {
                    if let Some(lines) = data.get("lines").and_then(Value::as_array) {
                        replayed_lines.extend(
                            lines
                                .iter()
                                .filter_map(Value::as_str)
                                .map(ToOwned::to_owned),
                        );
                    }
                }
                _ => {}
            },
            RunEvent::Finished { error, .. } => {
                assert!(error.is_none());
                saw_finished = true;
            }
        }
    }

    assert!(saw_history_skipped);
    assert!(saw_launched);
    assert!(saw_status);
    assert!(saw_finished);
    assert_eq!(replayed_lines.len(), RUN_LOG_LINES_KEPT);
    assert_eq!(replayed_lines.first().map(String::as_str), Some("line-350"));
    assert_eq!(replayed_lines.last().map(String::as_str), Some("line-2349"));

    // Large lines (> 4 MiB total) and > 600 status events still replay all newest 2,000 log lines.
    backend.set_run_behavior(RunBehavior::ChattyReady {
        total_lines: RUN_LOG_LINES_KEPT + 100,
        pad_bytes: 3 * 1024,
        extra_statuses: 700,
    });
    let heavy_id = state
        .start_plugin_run(account, existing_run_spec(session_name), Some(runtime))
        .await
        .unwrap();
    assert_eq!(wait_run_finished(&state, heavy_id).await, RunPhase::Ready);

    let heavy_run = state.plugin_run(heavy_id).expect("heavy run retained");
    let mut heavy_events = heavy_run.subscribe();
    let mut heavy_lines = Vec::new();
    let mut heavy_finished = false;
    while let Some(event) = heavy_events.next().await {
        match event {
            RunEvent::Progress { kind: "log", data } => {
                if let Some(lines) = data.get("lines").and_then(Value::as_array) {
                    heavy_lines.extend(
                        lines
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToOwned::to_owned),
                    );
                }
            }
            RunEvent::Finished { error, .. } => {
                assert!(error.is_none());
                heavy_finished = true;
            }
            _ => {}
        }
    }
    assert!(heavy_finished);
    assert_eq!(heavy_lines.len(), RUN_LOG_LINES_KEPT);
    assert!(heavy_lines[0].starts_with("line-100:"));
    assert!(
        heavy_lines
            .last()
            .unwrap()
            .starts_with(&format!("line-{}:", RUN_LOG_LINES_KEPT + 99))
    );
}

#[tokio::test]
async fn run_summary_phase_tracks_running_ready_failed_and_cancelled() {
    let backend = Arc::new(TestBackend::new());
    let state = WebState::start(backend.clone()).await.unwrap();
    let (account, runtime, session_name) = ready_context(&state).await;

    // Ready
    backend.set_run_behavior(RunBehavior::ChattyReady {
        total_lines: 3,
        pad_bytes: 0,
        extra_statuses: 0,
    });
    let ready_id = state
        .start_plugin_run(
            account.clone(),
            existing_run_spec(session_name.clone()),
            Some(runtime.clone()),
        )
        .await
        .unwrap();
    assert_eq!(wait_run_finished(&state, ready_id).await, RunPhase::Ready);

    // Failed
    backend.set_run_behavior(RunBehavior::Fail(ErrorKind::PluginRunFailed));
    let failed_id = state
        .start_plugin_run(
            account.clone(),
            existing_run_spec(session_name.clone()),
            Some(runtime.clone()),
        )
        .await
        .unwrap();
    assert_eq!(wait_run_finished(&state, failed_id).await, RunPhase::Failed);

    // Running -> Cancelled
    let (started_tx, started_rx) = mpsc::channel();
    backend.set_run_behavior(RunBehavior::HoldUntilCancelled {
        started: started_tx,
    });
    let cancelled_id = state
        .start_plugin_run(account, existing_run_spec(session_name), Some(runtime))
        .await
        .unwrap();
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(5)))
        .await
        .unwrap()
        .expect("run started");

    let running_summary = state
        .plugin_runs()
        .into_iter()
        .find(|r| r.id == cancelled_id)
        .expect("running summary");
    assert!(!running_summary.finished);
    assert_eq!(running_summary.phase, RunPhase::Running);
    assert_eq!(
        serde_json::to_value(&running_summary).unwrap()["phase"],
        "running"
    );

    assert!(state.cancel_plugin_run(cancelled_id));
    assert_eq!(
        wait_run_finished(&state, cancelled_id).await,
        RunPhase::Cancelled
    );

    let summaries = serde_json::to_value(state.plugin_runs()).unwrap();
    let by_id = |id: u64| {
        summaries
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(by_id(ready_id)["phase"], "ready");
    assert_eq!(by_id(ready_id)["finished"], true);
    assert_eq!(by_id(failed_id)["phase"], "failed");
    assert_eq!(by_id(failed_id)["finished"], true);
    assert_eq!(by_id(cancelled_id)["phase"], "cancelled");
    assert_eq!(by_id(cancelled_id)["finished"], true);
}

#[tokio::test]
async fn plugin_git_preview_cancel_aborts_clone_and_cleans_staging() {
    let staging = tempfile::tempdir().unwrap();
    let backend = Arc::new(TestBackend::new());
    let state = WebState::start(backend.clone()).await.unwrap();

    // Idle cancel is a no-op returning false.
    assert!(!state.cancel_plugin_preview());

    // 1. Explicit cancel while cloning kills the clone and cleans the temporary checkout directory.
    let (started_tx, started_rx) = mpsc::channel();
    backend.set_git_behavior(GitPreviewBehavior::BlockUntilCancelled {
        staging: staging.path().to_path_buf(),
        started: started_tx,
    });
    let Submission::Started { id, job } = state
        .start_plugin_preview(PluginOrigin::Git {
            url: "https://github.com/example/plugin.git".into(),
        })
        .unwrap()
    else {
        panic!("expected started preview");
    };
    let checkout_dir =
        tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .expect("clone started");
    assert!(checkout_dir.exists());

    // A second preview cannot overlap while the first is still running.
    let overlap = state
        .start_plugin_preview(PluginOrigin::Git {
            url: "https://github.com/example/other.git".into(),
        })
        .unwrap();
    assert!(matches!(overlap, Submission::AlreadyRunning { id: running } if running == id));

    assert!(state.cancel_plugin_preview());
    // Repeated cancel while still winding down stays idempotent.
    let err = state
        .finish_plugin_preview(id, job)
        .await
        .err()
        .expect("cancelled preview");
    assert!(err.is(ErrorKind::Cancelled), "{err:?}");
    assert!(!checkout_dir.exists(), "temp checkout dir must be removed");
    assert!(!state.cancel_plugin_preview());

    // 2. Late cancel after `inspect_plugin_git` returns still rejects and deletes `stage-*`.
    let (started_tx, started_rx) = mpsc::channel();
    let (proceed_tx, proceed_rx) = mpsc::channel();
    backend.set_git_behavior(GitPreviewBehavior::ReturnStagedAfterCancel {
        staging: staging.path().to_path_buf(),
        started: started_tx,
        proceed: Mutex::new(Some(proceed_rx)),
    });
    let preview_state = state.clone();
    let task = tokio::spawn(async move {
        preview_state
            .preview_plugin(PluginOrigin::Git {
                url: "https://github.com/example/late-cancel.git".into(),
            })
            .await
    });
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(5)))
        .await
        .unwrap()
        .expect("staged dir created");
    assert!(staging.path().join("stage-test-preview").exists());
    assert!(state.cancel_plugin_preview());
    let _ = proceed_tx.send(());
    let err = task
        .await
        .unwrap()
        .err()
        .expect("late-cancelled preview must fail");
    assert!(err.is(ErrorKind::Cancelled), "{err:?}");
    assert!(
        !staging.path().join("stage-test-preview").exists(),
        "staged preview dir must be discarded on cancel"
    );

    // 3. Dropping an awaited `preview_plugin` future cancels the background clone too.
    let (started_tx, started_rx) = mpsc::channel();
    backend.set_git_behavior(GitPreviewBehavior::BlockUntilCancelled {
        staging: staging.path().to_path_buf(),
        started: started_tx,
    });
    let drop_state = state.clone();
    let handle = tokio::spawn(async move {
        let _ = drop_state
            .preview_plugin(PluginOrigin::Git {
                url: "https://github.com/example/drop-cancel.git".into(),
            })
            .await;
    });
    let checkout_dir =
        tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .expect("clone started");
    handle.abort();
    let _ = handle.await;
    // Observe cleanup passively without calling `cancel_plugin_preview()`.
    let is_inspect_running = || {
        state.snapshot().operations.iter().any(|op| {
            matches!(
                &op.operation,
                Operation::Domain {
                    name: "inspect_plugin",
                    ..
                }
            )
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while checkout_dir.exists() || is_inspect_running() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("dropped preview cleans up clone");
}

#[tokio::test]
async fn gguf_listing_cache_reuses_per_repo_and_supports_explicit_refresh() {
    let backend = Arc::new(TestBackend::new());
    let calls = backend.hf_calls.clone();
    let state = WebState::start(backend.clone()).await.unwrap();

    // Concurrent misses for the same repo coalesce into one `hf_files()` call, even if
    // the first requester aborts mid-flight.
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *backend.hf_gate.lock().unwrap() = Some(HfGate {
        started: started_tx,
        release: Mutex::new(Some(release_rx)),
    });
    let first_state = state.clone();
    let first_req = tokio::spawn(async move {
        first_state
            .hf_gguf_listing("unsloth/Qwen3-0.6B-GGUF".into(), false)
            .await
    });
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(5)))
        .await
        .unwrap()
        .expect("first hf_files started");

    let second_state = state.clone();
    let second_req = tokio::spawn(async move {
        second_state
            .hf_gguf_listing("  unsloth/Qwen3-0.6B-GGUF ".into(), false)
            .await
    });
    // Let the second task subscribe to the in-flight lookup, then abort the first requester.
    tokio::task::yield_now().await;
    first_req.abort();
    let _ = first_req.await;
    let _ = release_tx.send(());

    let first = second_req.await.unwrap().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Subsequent lookups for the same repo hit cache with zero backend calls.
    let cached = state
        .hf_gguf_listing("  unsloth/Qwen3-0.6B-GGUF ".into(), false)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cached, first);

    // Explicit refresh hits the backend again and updates the cached listing.
    backend.hf_version.store(2, Ordering::SeqCst);
    let refreshed = state
        .hf_gguf_listing("unsloth/Qwen3-0.6B-GGUF".into(), true)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_ne!(refreshed, first);
    assert_eq!(refreshed.variants[0].size, 8_000_000_000);

    let cached_v2 = state
        .hf_gguf_listing("unsloth/Qwen3-0.6B-GGUF".into(), false)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(cached_v2, refreshed);

    // Errors are never cached.
    *backend.hf_fail.lock().unwrap() = true;
    assert!(
        state
            .hf_gguf_listing("unsloth/Failing-GGUF".into(), false)
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    *backend.hf_fail.lock().unwrap() = false;
    state
        .hf_gguf_listing("unsloth/Failing-GGUF".into(), false)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 4);

    // Deleting the HF token invalidates the cache inside the background operation even if
    // the caller drops the JoinHandle mid-flight.
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *backend.secret_gate.lock().unwrap() = Some(HfGate {
        started: started_tx,
        release: Mutex::new(Some(release_rx)),
    });
    let Submission::Started { job, .. } = state.delete_hf_token().unwrap() else {
        panic!("expected started delete_hf_token");
    };
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(5)))
        .await
        .unwrap()
        .expect("delete_secret started");
    drop(job);
    let _ = release_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.snapshot().operations.iter().any(|op| {
            matches!(
                &op.operation,
                Operation::Domain {
                    name: "hf_token",
                    ..
                }
            )
        }) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("hf_token delete finished");

    state
        .hf_gguf_listing("unsloth/Qwen3-0.6B-GGUF".into(), false)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 5);
}

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_mock_server(dir: &Path, access_key: &str) -> (Server, String) {
    let auth_dir = dir.join("web-auth");
    std::fs::create_dir_all(&auth_dir).unwrap();
    let hash: [u8; 32] = Sha256::digest(access_key.as_bytes()).into();
    std::fs::write(auth_dir.join("access-key.sha256"), hash).unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_colab-playground-web"));
    command
        .env("COLAB_PLAYGROUND_CONFIG_DIR", dir)
        .env_remove("COLAB_PLAYGROUND_BACKEND")
        .args(["--mock", "--no-open", "--port", "0"])
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
    (server, format!("http://{addr}"))
}

fn http_client() -> Agent {
    Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .into()
}

fn json_req(
    agent: &Agent,
    origin: &str,
    method: &str,
    path: &str,
    auth: Option<&str>,
    body: Option<&Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("{origin}{path}"))
        .header("Accept", "application/json");
    if let Some(token) = auth {
        builder = builder.header("Authorization", token);
    }
    let payload = if let Some(value) = body {
        builder = builder
            .header("Origin", origin)
            .header("Content-Type", "application/json");
        value.to_string()
    } else {
        String::new()
    };
    let mut resp = agent.run(builder.body(payload).unwrap()).unwrap();
    let status = resp.status();
    let text = resp.body_mut().read_to_string().unwrap();
    let parsed = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };
    (status, parsed)
}

#[test]
fn http_plugins_endpoints_expose_run_phase_preview_cancel_and_gguf_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let key = "test-plugins-backend-key";
    let (_server, origin) = spawn_mock_server(dir.path(), key);
    let agent = http_client();

    let (status, cred) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/login",
        None,
        Some(&json!({ "access_key": key })),
    );
    assert_eq!(status, StatusCode::OK);
    let auth = format!("Bearer {}", cred["token"].as_str().unwrap());

    // 1. Explicit preview cancel endpoint is wired and returns 204 when idle.
    let (status, _) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/previews/cancel",
        Some(&auth),
        Some(&json!({})),
    );
    assert_eq!(status, StatusCode::NO_CONTENT);

    // 2. GGUF endpoint recalculates across accelerator/VRAM/ctx/quant/KV and accepts `refresh`.
    let (status, search) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/hf/search",
        Some(&auth),
        Some(&json!({ "query": "qwen3" })),
    );
    assert_eq!(status, StatusCode::OK);
    let repo = search.as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (status, t4_auto) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/hf/gguf",
        Some(&auth),
        Some(&json!({
            "repo": repo,
            "accelerator": "T4",
            "fit": { "vram_mib": null, "ctx": 4096 },
            "quant": "auto",
        })),
    );
    assert_eq!(status, StatusCode::OK);
    let (status, a100_fixed) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/hf/gguf",
        Some(&auth),
        Some(&json!({
            "repo": repo,
            "accelerator": "A100",
            "fit": { "vram_mib": 40960, "ctx": 16384, "kv": "q8_0" },
            "quant": "Q4_K_M",
        })),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(t4_auto["listing"], a100_fixed["listing"]);
    assert_eq!(a100_fixed["fits"].as_array().unwrap().len(), 1);
    assert_eq!(a100_fixed["fits"][0]["vram_mib"], 40960);

    let (status, refreshed) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/hf/gguf",
        Some(&auth),
        Some(&json!({
            "repo": repo,
            "accelerator": "A100",
            "fit": { "vram_mib": null, "ctx": 0 },
            "quant": "auto",
            "refresh": true,
        })),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(refreshed["listing"], t4_auto["listing"]);

    // 3. `GET /api/plugins/runs` includes accurate `phase` alongside `finished`.
    let (status, sessions) = json_req(&agent, &origin, "GET", "/api/sessions", Some(&auth), None);
    assert_eq!(status, StatusCode::OK);
    let managed = sessions["runtimes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["managed"] == true && r["on_active_account"] == true)
        .unwrap()
        .clone();
    let session_name = managed["id"]["name"].as_str().unwrap().to_owned();

    let (status, accepted) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/runs",
        Some(&auth),
        Some(&json!({
            "account_context": sessions["account_context"],
            "spec": {
                "plugin": "llama-cpp",
                "inputs": {
                    "repo": repo,
                    "quant": "auto",
                    "ctx": 0,
                    "port": 8000,
                },
                "target": { "kind": "existing", "name": session_name },
                "stop_on_failure": true,
            },
            "existing": managed["id"],
        })),
    );
    assert_eq!(status, StatusCode::ACCEPTED);
    let run_id = accepted["id"].as_u64().unwrap();

    // Drain the SSE stream to completion.
    let sse_req = Request::builder()
        .method("POST")
        .uri(format!("{origin}/api/plugins/runs/{run_id}/events"))
        .header("Authorization", &auth)
        .header("Origin", &origin)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .body("{}".to_owned())
        .unwrap();
    let mut sse_resp = agent.run(sse_req).unwrap();
    assert_eq!(sse_resp.status(), StatusCode::OK);
    let stream_text = sse_resp.body_mut().read_to_string().unwrap();
    assert!(stream_text.contains("\"phase\":\"ready\""));

    let (status, runs) = json_req(
        &agent,
        &origin,
        "GET",
        "/api/plugins/runs",
        Some(&auth),
        None,
    );
    assert_eq!(status, StatusCode::OK);
    let summary = runs
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == run_id)
        .expect("run summary");
    assert_eq!(summary["finished"], true);
    assert_eq!(summary["phase"], "ready");
}
