use std::sync::mpsc;

use colab_playground_core::{
    backend::{Backend, RunTarget},
    mock::{MockBackend, MockConfig, MockFailures, MockScenario},
    plugins::InputValue,
    provision::ProvisionEvent,
    sessions::Accelerator,
    tunnel::TunnelSpec,
};
use tokio::time::{sleep, timeout};

use super::*;

const TEST_TIMEOUT: Duration = Duration::from_secs(8);

fn started<T>(submission: Submission<T>) -> (u64, JoinHandle<Result<T>>) {
    match submission {
        Submission::Started { id, job } => (id, job),
        Submission::AlreadyRunning { .. } => panic!("expected a new operation"),
    }
}

fn rejected<T>(result: Result<Submission<T>>, expected: ErrorKind) {
    match result {
        Err(error) => assert_eq!(error.kind, expected),
        Ok(_) => panic!("expected {expected:?}"),
    }
}

async fn ready(state: &WebState) -> Arc<Snapshot> {
    let mut snapshots = state.subscribe();
    timeout(TEST_TIMEOUT, async {
        loop {
            let snapshot = state.snapshot();
            if snapshot.runtimes.is_some() && state.lock().running.is_empty() {
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

async fn running_demo() -> (WebState, Arc<MockBackend>) {
    let mut config = MockConfig::interactive(Duration::from_millis(50));
    config.scenario.runtimes.clear();
    let backend = Arc::new(MockBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    ready(&state).await;
    (state, backend)
}

async fn wait_event<T: Send + 'static>(
    rx: mpsc::Receiver<T>,
    matches: impl Fn(T) -> bool + Send + 'static,
) {
    spawn_blocking(move || {
        let until = std::time::Instant::now() + TEST_TIMEOUT;
        while let Ok(event) =
            rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
        {
            if matches(event) {
                return;
            }
        }
        panic!("operation did not reach the expected phase");
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn account_metadata_cannot_replace_a_stale_usage_sample_with_a_fresh_copy() {
    let (config, _) = MockConfig::headless(MockScenario::single());
    let backend = Arc::new(MockBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    ready(&state).await;
    let cached = backend.accounts(&CancelToken::new()).unwrap();
    assert!(!cached.accounts[0].usage.unwrap().stale);

    backend.set_failures(MockFailures {
        usage_fetch_fails: true,
        ..Default::default()
    });
    assert!(
        state.refresh_accounts().await.unwrap().usage[0]
            .snapshot
            .unwrap()
            .stale
    );

    // The real account store keeps the last successful sample when a refresh fails.
    state.record_accounts(Ok(cached));
    let snapshot = state.snapshot();
    assert_eq!(
        snapshot.accounts.as_ref().unwrap().accounts[0].usage,
        snapshot.usage[0].snapshot
    );
    let mut missing = snapshot.usage.clone();
    missing[0].snapshot = None;
    state.record_usage(missing);
    assert_eq!(
        state.snapshot().usage[0].snapshot,
        snapshot.usage[0].snapshot
    );
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test]
async fn duplicate_provisions_share_an_id_and_stale_tabs_cannot_start_work() {
    let (state, backend) = running_demo().await;
    let initial = state.snapshot();
    let other = initial.accounts.as_ref().unwrap().accounts[1].id.clone();
    let account = initial.account.clone();
    let spec = ProvisionSpec::new("one-cpu", Accelerator::None, &backend.defaults());
    let (events, received) = mpsc::channel();

    let (id, job) = started(
        state
            .provision(account.clone(), spec.clone(), events)
            .unwrap(),
    );
    assert!(matches!(
        state.provision(account.clone(), spec.clone(), mpsc::channel().0).unwrap(),
        Submission::AlreadyRunning { id: duplicate } if duplicate == id
    ));
    rejected(
        state.switch_account(account.clone(), other.clone()),
        ErrorKind::Busy,
    );

    assert_eq!(job.await.unwrap().unwrap().name, "one-cpu");
    assert_eq!(
        received
            .try_iter()
            .filter(|event| matches!(event, ProvisionEvent::Allocating { .. }))
            .count(),
        1,
    );
    timeout(
        TEST_TIMEOUT,
        state.subscribe().wait_for(|snapshot| {
            snapshot
                .runtimes
                .as_ref()
                .is_some_and(|view| view.runtimes.len() == 1)
        }),
    )
    .await
    .unwrap()
    .unwrap();
    ready(&state).await;

    let (_, switch) = started(
        state
            .switch_account(account.clone(), other.clone())
            .unwrap(),
    );
    assert_eq!(switch.await.unwrap().unwrap().active, Some(other));
    ready(&state).await;
    rejected(
        state.provision(account.clone(), spec.clone(), mpsc::channel().0),
        ErrorKind::AccountNotActive,
    );
    let (_, switch_back) = started(
        state
            .switch_account(
                state.snapshot().account.clone(),
                account.active.clone().unwrap(),
            )
            .unwrap(),
    );
    switch_back.await.unwrap().unwrap();
    rejected(
        state.provision(account, spec, mpsc::channel().0),
        ErrorKind::AccountNotActive,
    );
    assert_eq!(state.shutdown(TEST_TIMEOUT).await.billing.managed, 1);
}

#[tokio::test]
async fn login_timeout_rolls_back_and_releases_the_slot() {
    let (config, _) = MockConfig::headless(MockScenario::demo());
    let backend = Arc::new(MockBackend::new(config));
    let inactivity = Duration::from_millis(250);
    let state = WebState::start_with_timeout(backend.clone(), inactivity, ForwardPolicy::default())
        .await
        .unwrap();
    let initial = ready(&state).await;
    let account = initial.account.clone();
    let other = initial.accounts.as_ref().unwrap().accounts[1].id.clone();

    let (_, job) = started(state.begin_login(account.clone()).unwrap());
    let prompt = job.await.unwrap().unwrap();
    assert!(prompt.auth_url.starts_with("https://"));
    assert_eq!(state.snapshot().login_id, Some(prompt.id));
    rejected(
        state.switch_account(account.clone(), other.clone()),
        ErrorKind::Busy,
    );

    let listings = backend.runtime_listings();
    state.0.refresh.notify_one();
    sleep(inactivity / 4).await;
    assert_eq!(backend.runtime_listings(), listings);
    assert_eq!(state.snapshot().guard, initial.guard);

    timeout(TEST_TIMEOUT, async {
        sleep(inactivity).await;
        ready(&state).await;
    })
    .await
    .unwrap();
    assert!(state.snapshot().login_id.is_none());
    rejected(
        state.submit_login(prompt.id, "expired".into()),
        ErrorKind::LoginCancelled,
    );
    let slot = backend.accounts(&CancelToken::new()).unwrap();
    assert_eq!(slot.active, account.active);
    assert!(slot.has_token);
    let (_, switch) = started(state.switch_account(account, other.clone()).unwrap());
    assert_eq!(switch.await.unwrap().unwrap().active, Some(other));
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test]
async fn shutdown_cancels_a_fresh_plugin_run_and_closes_existing_forwards() {
    let mut config = MockConfig::interactive(Duration::from_millis(80));
    config.scenario.runtimes.truncate(1);
    config.defaults.usage_poll_active = Duration::from_millis(100);
    let backend = Arc::new(MockBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    let initial = ready(&state).await;
    let existing = initial.runtimes.as_ref().unwrap().runtimes[0].id.clone();
    let account = initial.account.clone();
    let forward = TunnelSpec {
        account: existing.account,
        session: existing.name.unwrap(),
        local_port: 18000,
        remote_port: 8000,
        health_path: None,
        bind: Default::default(),
    };
    let (_, opening) = started(
        state
            .start_operation(
                "open_forward",
                "18000".into(),
                Access::Account(account.clone()),
                move |backend, _| backend.open_tunnel(forward, mpsc::channel().0),
            )
            .unwrap(),
    );
    opening.await.unwrap().unwrap();

    let mut spec = backend.plugin_run_template("llama-cpp").unwrap();
    spec.inputs.insert(
        "repo".into(),
        InputValue::Text("unsloth/Qwen3-0.6B-GGUF".into()),
    );
    let RunTarget::Provision(provision) = &mut spec.target else {
        panic!("expected a fresh runtime");
    };
    provision.name = "plugin-runtime".into();
    provision.min_vram_mib = None;
    let (events, received) = mpsc::channel();
    let (id, job) = started(
        state
            .run_plugin(account.clone(), spec.clone(), None, events)
            .unwrap(),
    );
    assert!(matches!(
        state.run_plugin(account.clone(), spec, None, mpsc::channel().0).unwrap(),
        Submission::AlreadyRunning { id: duplicate } if duplicate == id
    ));
    let other = initial.accounts.as_ref().unwrap().accounts[1].id.clone();
    rejected(state.switch_account(account, other), ErrorKind::Busy);
    let previous = initial.guard.as_ref().unwrap().usage[0]
        .snapshot
        .unwrap()
        .fetched_at;
    state.0.refresh.notify_one();
    timeout(
        TEST_TIMEOUT,
        state.subscribe().wait_for(|snapshot| {
            snapshot.operations.iter().any(|op| op.id == id)
                && snapshot.guard.as_ref().unwrap().usage[0]
                    .snapshot
                    .unwrap()
                    .fetched_at
                    > previous
                && snapshot.tunnels.len() == 1
        }),
    )
    .await
    .unwrap()
    .unwrap();
    wait_event(received, |event| {
        matches!(event, PluginRunEvent::Launched { .. })
    })
    .await;

    let report = state.shutdown(TEST_TIMEOUT).await;
    assert!(report.completed);
    assert_eq!(report.forwards_closed, 1);
    assert_eq!(report.billing.managed, 1);
    assert!(!report.billing.unknown);
    assert!(job.await.unwrap().unwrap_err().is(ErrorKind::Cancelled));
    assert!(backend.tunnels().is_empty());
    let snapshot = state.snapshot();
    let runtimes = &snapshot.runtimes.as_ref().unwrap().runtimes;
    assert_eq!(runtimes.len(), 1);
    assert_eq!(runtimes[0].id.name.as_deref(), Some("a100-7f3a"));
}

#[tokio::test]
async fn shutdown_cancels_a_provision_and_checks_the_cleanup() {
    let (state, backend) = running_demo().await;
    let account = state.snapshot().account.clone();
    let spec = ProvisionSpec::new("cancel-this", Accelerator::None, &backend.defaults());
    let (events, received) = mpsc::channel();
    let (_, job) = started(state.provision(account, spec, events).unwrap());
    wait_event(received, |event| {
        matches!(event, ProvisionEvent::Allocated { .. })
    })
    .await;
    let report = state.shutdown(TEST_TIMEOUT).await;
    assert!(report.completed);
    assert_eq!(report.billing.managed, 0);
    assert!(!report.billing.unknown);
    assert!(job.await.unwrap().unwrap_err().is(ErrorKind::Cancelled));
}

#[tokio::test]
async fn shutdown_reports_unknown_when_a_worker_cannot_finish_within_the_grace_period() {
    let (state, _) = running_demo().await;
    let (release, held) = mpsc::channel();
    let (entered, running) = tokio::sync::oneshot::channel();
    let (_, job) = started(
        state
            .start_operation("held", String::new(), Access::Independent, move |_, _| {
                entered.send(()).unwrap();
                let _ = held.recv_timeout(TEST_TIMEOUT);
                Ok(())
            })
            .unwrap(),
    );
    timeout(TEST_TIMEOUT, running).await.unwrap().unwrap();
    let grace = Duration::from_millis(500);
    let report = timeout(grace * 2, state.shutdown(grace)).await.unwrap();
    release.send(()).unwrap();
    job.await.unwrap().unwrap();
    assert!(!report.completed);
    assert!(report.billing.unknown);
    rejected(
        state.start_operation(
            "too_late",
            String::new(),
            Access::Independent,
            |_, _| Ok(()),
        ),
        ErrorKind::Cancelled,
    );
}

struct HoldStep {
    clock: colab_playground_core::clock::ManualClock,
    steps: std::sync::atomic::AtomicUsize,
    reached: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl colab_playground_core::clock::Clock for HoldStep {
    fn now(&self) -> std::time::SystemTime {
        self.clock.now()
    }

    fn sleep(&self, duration: Duration, cancel: &CancelToken) -> Result<()> {
        use std::sync::atomic::Ordering::SeqCst;

        self.clock.sleep(duration, cancel)?;
        if self
            .steps
            .try_update(SeqCst, SeqCst, |steps| steps.checked_sub(1))
            == Ok(1)
        {
            self.reached.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(TEST_TIMEOUT)
                .unwrap();
        }
        cancel.check()
    }
}

async fn demo_with_held_step() -> (
    WebState,
    Arc<MockBackend>,
    Arc<HoldStep>,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
) {
    let (mut config, clock) = MockConfig::headless(MockScenario::demo());
    let (reached, at_step) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let step = Arc::new(HoldStep {
        clock,
        steps: 0.into(),
        reached,
        release: Mutex::new(release),
    });
    config.clock = step.clone();
    let backend = Arc::new(MockBackend::new(config));
    let state = WebState::start(backend.clone()).await.unwrap();
    ready(&state).await;
    (state, backend, step, at_step, resume)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_account_write_is_accepted_while_a_background_poll_finishes() {
    use std::sync::atomic::Ordering::SeqCst;

    let (state, _, step, at_step, resume) = demo_with_held_step().await;
    step.steps.store(1, SeqCst);
    state.0.refresh.notify_one();
    at_step.recv_timeout(TEST_TIMEOUT).unwrap();
    let snapshot = state.snapshot();
    let to = snapshot.accounts.as_ref().unwrap().accounts[1].id.clone();

    let (id, job) = started(
        state
            .switch_account(snapshot.account.clone(), to.clone())
            .unwrap(),
    );
    assert_eq!(state.snapshot().operations[0].id, id);
    assert!(!job.is_finished());
    resume.send(()).unwrap();
    assert_eq!(job.await.unwrap().unwrap().active, Some(to));
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_switch_rechecks_accounts_without_marking_the_list_failed() {
    use std::sync::atomic::Ordering::SeqCst;

    let (state, _, step, at_step, resume) = demo_with_held_step().await;
    let initial = state.snapshot();
    let to = initial.accounts.as_ref().unwrap().accounts[1].id.clone();
    step.steps.store(2, SeqCst);
    let (id, switch) = started(state.switch_account(initial.account.clone(), to).unwrap());
    at_step.recv_timeout(TEST_TIMEOUT).unwrap();
    assert!(state.cancel(id));

    step.steps.store(1, SeqCst);
    resume.send(()).unwrap();
    at_step.recv_timeout(TEST_TIMEOUT).unwrap();
    let after = state.snapshot();
    assert!(after.accounts_error.is_none());
    assert_eq!(after.account, initial.account);
    resume.send(()).unwrap();
    assert!(switch.await.unwrap().unwrap_err().is(ErrorKind::Cancelled));
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn login_keeps_its_job_id_and_rolls_back_if_cancelled_while_opening() {
    use std::sync::atomic::Ordering::SeqCst;

    let (state, backend, step, at_step, resume) = demo_with_held_step().await;
    let account = state.snapshot().account.clone();

    step.steps.store(2, SeqCst);
    let (id, login) = started(state.begin_login(account.clone()).unwrap());
    at_step.recv_timeout(TEST_TIMEOUT).unwrap();
    let (other, job) = started(
        state
            .start_operation("other", String::new(), Access::Independent, |_, _| Ok(()))
            .unwrap(),
    );
    assert_ne!(id, other);
    resume.send(()).unwrap();
    job.await.unwrap().unwrap();
    let prompt = login.await.unwrap().unwrap();
    assert_eq!(prompt.id, id);
    assert_eq!(state.snapshot().login_id, Some(id));
    let (_, rollback) = started(state.cancel_login(prompt.id).unwrap().unwrap());
    rollback.await.unwrap().unwrap();
    ready(&state).await;

    step.steps.store(2, SeqCst);
    let (id, login) = started(state.begin_login(account.clone()).unwrap());
    at_step.recv_timeout(TEST_TIMEOUT).unwrap();
    assert!(state.cancel(id));
    resume.send(()).unwrap();
    assert!(matches!(login.await.unwrap(), Err(error) if error.is(ErrorKind::Cancelled)));
    assert!(state.snapshot().login_id.is_none());
    assert_eq!(
        backend.accounts(&CancelToken::new()).unwrap().active,
        account.active
    );
    assert!(state.shutdown(TEST_TIMEOUT).await.completed);
}
