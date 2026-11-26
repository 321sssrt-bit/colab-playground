use std::{
    collections::VecDeque,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

use colab_playground_core::{
    CancelToken, Defaults, Error, ErrorKind, Result,
    accounts::{Account, AccountId, AccountsView},
    backend::*,
    guard::{Concern, Decision, Limit, USAGE_STALE_AFTER},
    hf::HfModel,
    host::{Line, ProbeReport},
    mock::{MockBackend, MockConfig, MockFailures, MockScenario},
    plugins::{PluginInfo, PluginPreview},
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    quant::GgufListing,
    sessions::{Accelerator, HardwareRate, WatchdogInfo},
    tunnel::{TunnelEvent, TunnelId, TunnelInfo, TunnelSpec},
};
use colab_playground_web::state::{
    EndReason, GuardEventKind, Snapshot, Submission, WebState, sessions::AutoStop,
};
use tokio::time::{sleep, timeout};

const TEST_TIMEOUT: Duration = Duration::from_secs(8);

struct CountingBackend {
    mock: MockBackend,
    accounts_calls: AtomicUsize,
    runtimes_calls: AtomicUsize,
    guard_poll_calls: AtomicUsize,
    refresh_usage_calls: AtomicUsize,
    scripted_guard: Mutex<VecDeque<Result<GuardReport>>>,
}

impl CountingBackend {
    fn new(config: MockConfig) -> Self {
        Self {
            mock: MockBackend::new(config),
            accounts_calls: AtomicUsize::new(0),
            runtimes_calls: AtomicUsize::new(0),
            guard_poll_calls: AtomicUsize::new(0),
            refresh_usage_calls: AtomicUsize::new(0),
            scripted_guard: Mutex::new(VecDeque::new()),
        }
    }

    fn counts(&self) -> (usize, usize, usize, usize) {
        (
            self.accounts_calls.load(Ordering::SeqCst),
            self.runtimes_calls.load(Ordering::SeqCst),
            self.guard_poll_calls.load(Ordering::SeqCst),
            self.refresh_usage_calls.load(Ordering::SeqCst),
        )
    }

    fn push_guard(&self, result: Result<GuardReport>) {
        self.scripted_guard.lock().unwrap().push_back(result);
    }
}

macro_rules! forward_backend {
    ($(fn $name:ident($($arg:ident: $ty:ty),*) $(-> $ret:ty)?;)*) => {
        $(fn $name(&self, $($arg: $ty),*) $(-> $ret)? {
            self.mock.$name($($arg),*)
        })*
    };
}

impl Backend for CountingBackend {
    forward_backend! {
        fn kind() -> BackendKind;
        fn defaults() -> Defaults;
        fn set_defaults(defaults: Defaults);
        fn now() -> SystemTime;
        fn probe(cancel: &CancelToken) -> Result<ProbeReport>;
        fn install_cli(method: InstallMethod, log: Events<Line>, cancel: &CancelToken) -> Result<()>;
        fn adopt_active_account(cancel: &CancelToken) -> Result<Account>;
        fn begin_add_account(cancel: &CancelToken) -> Result<Box<dyn LoginFlow>>;
        fn switch_impact(to: &AccountId) -> Result<SwitchImpact>;
        fn switch_account(to: &AccountId, cancel: &CancelToken) -> Result<AccountsView>;
        fn remove_account(id: &AccountId, cancel: &CancelToken) -> Result<()>;
        fn usage() -> Vec<AccountUsageView>;
        fn usage_poll_due() -> bool;
        fn measured_rates() -> Vec<HardwareRate>;
        fn new_session_name(prefix: Option<&str>) -> String;
        fn provision(spec: ProvisionSpec, events: Events<ProvisionEvent>, cancel: &CancelToken) -> Result<ProvisionOutcome>;
        fn stop_session(target: &RuntimeRef, options: StopOptions, cancel: &CancelToken) -> Result<()>;
        fn extend_session(target: &RuntimeRef, by: Duration, cancel: &CancelToken) -> Result<Extension>;
        fn set_auto_stop(target: &RuntimeRef, runtime: Duration, cancel: &CancelToken) -> Result<WatchdogInfo>;
        fn cancel_auto_stop(target: &RuntimeRef, cancel: &CancelToken) -> Result<()>;
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

    fn accounts(&self, cancel: &CancelToken) -> Result<AccountsView> {
        self.accounts_calls.fetch_add(1, Ordering::SeqCst);
        self.mock.accounts(cancel)
    }

    fn runtimes(&self, cancel: &CancelToken) -> Result<RuntimesView> {
        self.runtimes_calls.fetch_add(1, Ordering::SeqCst);
        self.mock.runtimes(cancel)
    }

    fn refresh_usage(
        &self,
        accounts: &[AccountId],
        cancel: &CancelToken,
    ) -> Result<Vec<AccountUsageView>> {
        self.refresh_usage_calls.fetch_add(1, Ordering::SeqCst);
        self.mock.refresh_usage(accounts, cancel)
    }

    fn guard_poll(&self, cancel: &CancelToken) -> Result<GuardReport> {
        self.guard_poll_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(scripted) = self.scripted_guard.lock().unwrap().pop_front() {
            return scripted;
        }
        self.mock.guard_poll(cancel)
    }
}

async fn wait_settled(state: &WebState, pred: impl Fn(&Snapshot) -> bool) -> Arc<Snapshot> {
    let mut rx = state.subscribe();
    timeout(TEST_TIMEOUT, async {
        loop {
            let snap = state.snapshot();
            if pred(&snap) {
                return snap;
            }
            let _ = rx.changed().await;
        }
    })
    .await
    .expect("timed out waiting for snapshot condition")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_cli_and_locked_keyring_stop_background_polling_and_version_churn() {
    for (cli_missing, keyring_unavailable, expected_error) in [
        (true, false, ErrorKind::NotInstalled),
        (false, true, ErrorKind::KeyringUnavailable),
    ] {
        let (mut config, _) = MockConfig::headless(MockScenario::demo());
        config.step_delay = Duration::ZERO;
        config.failures.cli_missing = cli_missing;
        config.failures.keyring_unavailable = keyring_unavailable;
        let backend = Arc::new(CountingBackend::new(config));
        let state = WebState::start(backend.clone()).await.unwrap();

        let initial = wait_settled(&state, |snap| {
            snap.accounts_error == Some(expected_error)
                && snap.runtimes_error == Some(expected_error)
        })
        .await;
        let version_before = initial.version;
        let counts_before = backend.counts();
        assert_eq!(
            counts_before.1, 0,
            "must not list runtimes when accounts failed"
        );
        assert_eq!(counts_before.2, 0, "must not run guard_poll");
        assert_eq!(counts_before.3, 0, "must not refresh usage");

        // Wait past one 5s poll tick to confirm zero background spin.
        sleep(Duration::from_millis(5300)).await;
        assert_eq!(
            backend.counts(),
            counts_before,
            "background poller must not call backend while {expected_error:?}"
        );
        assert_eq!(
            state.snapshot().version,
            version_before,
            "snapshot.version must not increment with no changes"
        );

        // Explicit recovery resumes normal state.
        backend.mock.set_failures(MockFailures::default());
        let (report, recovered, _) = state.probe_environment().await.unwrap();
        assert!(report.colab.is_some());
        assert!(recovered.accounts_error.is_none());
        assert!(recovered.accounts.is_some());
        assert!(recovered.runtimes.is_some());

        assert!(state.shutdown(TEST_TIMEOUT).await.completed);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zero_running_sessions_skips_guard_poll_and_avoids_version_churn() {
    let (mut config, clock) = MockConfig::headless(MockScenario::single());
    config.step_delay = Duration::ZERO;
    config.defaults.usage_poll_idle = Duration::from_secs(60);
    let backend = Arc::new(CountingBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();

    let initial = wait_settled(&state, |snap| {
        snap.runtimes.is_some()
            && !snap.usage.is_empty()
            && snap.usage.iter().all(|u| u.snapshot.is_some())
    })
    .await;
    assert_eq!(backend.guard_poll_calls.load(Ordering::SeqCst), 0);
    let version_after_init = initial.version;

    // Poll tick while not due: no backend calls and no version bump.
    let counts_idle = backend.counts();
    sleep(Duration::from_millis(5300)).await;
    assert_eq!(backend.counts(), counts_idle);
    assert_eq!(state.snapshot().version, version_after_init);

    // Advance past poll cadence (still 0 runtimes): usage refreshes, guard_poll stays 0.
    clock.advance(Duration::from_secs(61));
    let refreshed = state.refresh_accounts().await.unwrap();
    assert_eq!(backend.guard_poll_calls.load(Ordering::SeqCst), 0);
    assert!(refreshed.runtimes.is_some());

    // Calling refresh again at the exact same backend clock produces identical data -> no version bump.
    let version_same = refreshed.version;
    let again = state.refresh_accounts().await.unwrap();
    assert_eq!(backend.guard_poll_calls.load(Ordering::SeqCst), 0);
    assert_eq!(again.version, version_same);

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transient_busy_from_guard_poll_is_ignored_without_setting_guard_error() {
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.step_delay = Duration::ZERO;
    let backend = Arc::new(CountingBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    wait_settled(&state, |snap| {
        snap.runtimes.is_some() && snap.guard.is_some()
    })
    .await;

    backend.push_guard(Err(Error::new(ErrorKind::Busy)));
    let after_busy = state.refresh_accounts().await.unwrap();
    assert_eq!(after_busy.guard_error, None);

    // A non-Busy guard failure is reported, and a subsequent success clears it.
    backend.push_guard(Err(Error::new(ErrorKind::Http)));
    let after_http = state.refresh_accounts().await.unwrap();
    assert_eq!(after_http.guard_error, Some(ErrorKind::Http));

    let after_recovery = state.refresh_accounts().await.unwrap();
    assert_eq!(after_recovery.guard_error, None);

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guard_decisions_are_retained_across_polls_until_acked_and_never_misclassified_as_vanished()
{
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.step_delay = Duration::ZERO;
    let backend = Arc::new(CountingBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_settled(&state, |snap| {
        snap.runtimes.is_some() && snap.guard.is_some()
    })
    .await;

    let runtimes = &initial.runtimes.as_ref().unwrap().runtimes;
    let warn_ref = runtimes
        .iter()
        .find(|r| r.id.name.as_deref() == Some("a100-7f3a"))
        .unwrap()
        .id
        .clone();
    let fail_ref = runtimes
        .iter()
        .find(|r| r.id.name.as_deref() == Some("t4-91c2"))
        .unwrap()
        .id
        .clone();
    let stop_ref = runtimes
        .iter()
        .find(|r| r.id.name.as_deref() == Some("cpu-0b5e"))
        .unwrap()
        .id
        .clone();

    let warn_concern = Concern::Limit {
        limit: Limit::Runtime,
        current: 6000.0,
        threshold: 7200.0,
        estimated: false,
    };
    let fail_concern = Concern::Limit {
        limit: Limit::Spend,
        current: 10.5,
        threshold: 10.0,
        estimated: false,
    };
    let stop_concern = Concern::Limit {
        limit: Limit::Balance,
        current: 1.0,
        threshold: 5.0,
        estimated: false,
    };

    // Round 1: Warn + Stop{stopped: false} + Stop{stopped: true}.
    backend.push_guard(Ok(GuardReport {
        decisions: vec![
            GuardDecision {
                session: warn_ref.clone(),
                decision: Decision::Warn(vec![warn_concern.clone()]),
                stopped: false,
                error: None,
            },
            GuardDecision {
                session: fail_ref.clone(),
                decision: Decision::Stop(fail_concern.clone()),
                stopped: false,
                error: Some(Error::new(ErrorKind::Http).detail("stop failed")),
            },
            GuardDecision {
                session: stop_ref.clone(),
                decision: Decision::Stop(stop_concern.clone()),
                stopped: true,
                error: None,
            },
        ],
        vanished: Vec::new(),
        usage: backend.mock.usage(),
    }));
    let round1 = state.refresh_accounts().await.unwrap();
    assert_eq!(round1.guard_events.len(), 3);
    assert!(
        round1
            .guard_events
            .iter()
            .any(|e| { e.session == warn_ref && matches!(e.kind, GuardEventKind::Warn { .. }) })
    );
    assert!(
        round1.guard_events.iter().any(|e| {
            e.session == fail_ref && matches!(e.kind, GuardEventKind::StopFailed { .. })
        })
    );
    assert!(
        round1
            .guard_events
            .iter()
            .any(|e| { e.session == stop_ref && matches!(e.kind, GuardEventKind::Stopped { .. }) })
    );

    // Round 2: subsequent poll returns Ok for live sessions and reports the guard-stopped
    // session in `vanished`. Retained events must survive and `stop_ref` must not become Vanished.
    backend.push_guard(Ok(GuardReport {
        decisions: vec![
            GuardDecision {
                session: warn_ref.clone(),
                decision: Decision::Ok,
                stopped: false,
                error: None,
            },
            GuardDecision {
                session: fail_ref.clone(),
                decision: Decision::Ok,
                stopped: false,
                error: None,
            },
        ],
        vanished: vec![stop_ref.clone()],
        usage: backend.mock.usage(),
    }));
    let round2 = state.refresh_accounts().await.unwrap();
    assert_eq!(round2.guard_events.len(), 3);
    assert!(
        !round2
            .guard_events
            .iter()
            .any(|e| { e.session == stop_ref && matches!(e.kind, GuardEventKind::Vanished) })
    );
    let report = round2.guard.as_ref().unwrap();
    assert!(
        report
            .decisions
            .iter()
            .any(|d| { d.session == warn_ref && matches!(d.decision, Decision::Warn(_)) })
    );
    assert!(report.decisions.iter().any(|d| {
        d.session == fail_ref && matches!(d.decision, Decision::Stop(_)) && !d.stopped
    }));
    assert!(report.decisions.iter().any(|d| {
        d.session == stop_ref && matches!(d.decision, Decision::Stop(_)) && d.stopped
    }));
    assert!(!report.vanished.contains(&stop_ref));
    assert!(
        round2
            .ended
            .iter()
            .any(|e| { e.runtime == stop_ref && matches!(e.reason, EndReason::Guard { .. }) })
    );

    // Consume all events: guard_events clears, stopped decision drops from active report,
    // ended history keeps Guard reason, and live stop-failure stays visible because it still bills.
    let max_id = round2.guard_events.iter().map(|e| e.id).max().unwrap();
    assert_eq!(state.ack_guard_events(Some(max_id), None), 3);
    let after_ack = state.snapshot();
    assert!(after_ack.guard_events.is_empty());
    let report_after_ack = after_ack.guard.as_ref().unwrap();
    assert!(
        !report_after_ack
            .decisions
            .iter()
            .any(|d| d.session == stop_ref)
    );
    assert!(report_after_ack.decisions.iter().any(|d| {
        d.session == fail_ref && matches!(d.decision, Decision::Stop(_)) && !d.stopped
    }));
    assert!(
        after_ack
            .ended
            .iter()
            .any(|e| { e.runtime == stop_ref && matches!(e.reason, EndReason::Guard { .. }) })
    );

    // Manual stop records User reason and also resists a later vanished report.
    let Submission::Started { job, .. } = state.stop_runtime(fail_ref.clone()).unwrap() else {
        panic!("expected stop job");
    };
    job.await.unwrap().unwrap();
    backend.push_guard(Ok(GuardReport {
        decisions: vec![],
        vanished: vec![fail_ref.clone()],
        usage: backend.mock.usage(),
    }));
    let after_user_stop = state.refresh_accounts().await.unwrap();
    assert!(
        !after_user_stop
            .guard_events
            .iter()
            .any(|e| { e.session == fail_ref && matches!(e.kind, GuardEventKind::Vanished) })
    );
    assert!(
        after_user_stop
            .ended
            .iter()
            .any(|e| { e.runtime == fail_ref && e.reason == EndReason::User })
    );

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_refresh_syncs_all_three_and_mutations_list_runtimes_once() {
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.step_delay = Duration::ZERO;
    let backend = Arc::new(CountingBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = wait_settled(&state, |snap| {
        snap.runtimes.is_some() && snap.guard.is_some()
    })
    .await;

    let before = backend.counts();
    let _ = state.refresh_accounts().await.unwrap();
    let after = backend.counts();
    assert_eq!(after.0, before.0 + 1, "accounts refreshed");
    assert_eq!(after.1, before.1 + 1, "runtimes listed once");
    assert_eq!(after.2, before.2 + 1, "guard_poll ran");

    let target = initial
        .runtimes
        .as_ref()
        .unwrap()
        .runtimes
        .iter()
        .find(|r| r.id.name.as_deref() == Some("a100-7f3a"))
        .unwrap()
        .id
        .clone();

    for action in [
        AutoStop::Set(Duration::from_secs(600)),
        AutoStop::Extend(Duration::from_secs(120)),
        AutoStop::Cancel,
    ] {
        let listings = backend.runtimes_calls.load(Ordering::SeqCst);
        let Submission::Started { job, .. } = state
            .change_auto_stop(initial.account.clone(), target.clone(), action)
            .unwrap()
        else {
            panic!("expected auto-stop job");
        };
        job.await.unwrap().unwrap();
        sleep(Duration::from_millis(40)).await;
        assert_eq!(
            backend.runtimes_calls.load(Ordering::SeqCst),
            listings + 1,
            "auto-stop mutation must list runtimes exactly once"
        );
    }

    let listings = backend.runtimes_calls.load(Ordering::SeqCst);
    let Submission::Started { job, .. } = state.stop_runtime(target).unwrap() else {
        panic!("expected stop job");
    };
    job.await.unwrap().unwrap();
    sleep(Duration::from_millis(40)).await;
    assert_eq!(
        backend.runtimes_calls.load(Ordering::SeqCst),
        listings + 1,
        "single stop must list runtimes exactly once"
    );

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_aging_preserves_stale_flag_and_measured_rates_survive_stop() {
    let (mut config, clock) = MockConfig::headless(MockScenario::single());
    config.step_delay = Duration::ZERO;
    config.defaults.usage_poll_idle = Duration::from_secs(3600);
    let backend = Arc::new(CountingBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();

    let initial = wait_settled(&state, |snap| {
        snap.runtimes.is_some()
            && !snap.usage.is_empty()
            && snap.usage.iter().all(|u| u.snapshot.is_some())
    })
    .await;
    let fetched_at = initial.usage[0].snapshot.unwrap().fetched_at;
    assert!(!initial.usage[0].snapshot.unwrap().stale);
    let version_fresh = initial.version;

    // Advance past USAGE_STALE_AFTER without a fetch failure.
    clock.advance(USAGE_STALE_AFTER + Duration::from_secs(5));
    let aged = state.accounts_snapshot();
    assert!(!aged.usage[0].snapshot.unwrap().stale);
    assert!(aged.usage[0].last_error.is_none());
    assert!(aged.server_now.duration_since(fetched_at).unwrap() > USAGE_STALE_AFTER);
    assert_eq!(aged.version, version_fresh + 1);

    // Repeating accounts_snapshot after crossing the threshold must not bump version again.
    let aged_again = state.accounts_snapshot();
    assert_eq!(aged_again.version, aged.version);

    // Provision a sole T4 session, measure its rate, stop it, and confirm measured_rates stays.
    let spec = ProvisionSpec::new("solo-t4", Accelerator::T4, &backend.defaults());
    let (tx, _rx) = std::sync::mpsc::channel();
    let Submission::Started { job, .. } = state
        .provision(state.snapshot().account.clone(), spec, tx)
        .unwrap()
    else {
        panic!("expected provision job");
    };
    job.await.unwrap().unwrap();
    let with_runtime = state.refresh_accounts().await.unwrap();
    assert!(
        with_runtime
            .measured_rates
            .iter()
            .any(|rate| rate.matches(Accelerator::T4, false))
    );

    let target = with_runtime
        .runtimes
        .as_ref()
        .unwrap()
        .runtimes
        .iter()
        .find(|r| r.id.name.as_deref() == Some("solo-t4"))
        .unwrap()
        .id
        .clone();
    let Submission::Started { job, .. } = state.stop_runtime(target).unwrap() else {
        panic!("expected stop job");
    };
    job.await.unwrap().unwrap();

    let after_stop = state.snapshot();
    assert!(after_stop.runtimes.as_ref().unwrap().runtimes.is_empty());
    let t4_rate = after_stop
        .measured_rates
        .iter()
        .find(|rate| rate.matches(Accelerator::T4, false))
        .expect("measured rate must survive stopping the session");
    assert!(t4_rate.reading.cu_per_hour > 0.0);

    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}
