use std::{
    collections::VecDeque,
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use colab_playground_core::{
    CancelToken, Clock as _, Defaults, Error, ErrorKind, Result,
    accounts::{Account, AccountId, AccountsView},
    backend::*,
    hf::HfModel,
    host::{Line, ProbeReport},
    http::{HttpClient, HttpResponse},
    mock::{MockBackend, MockConfig, MockFailures, MockScenario},
    plugins::{PluginInfo, PluginPreview},
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    quant::GgufListing,
    sessions::{HardwareRate, WatchdogInfo},
    tunnel::{TunnelEvent, TunnelId, TunnelInfo, TunnelSpec},
    update::Version,
};
use colab_playground_shared::settings::SettingsStore;
use ureq::http::StatusCode;

use super::{exercise, exercise_backend_with_updates, json};
use crate::api::{UpdateRepository, WebSettings, WebUpdates};

const DAY_SECS: u64 = 24 * 3600;
const HOUR_SECS: u64 = 3600;
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn next_patch_version() -> String {
    let v = Version::parse(VERSION).expect("semantic version");
    format!("{}.{}.{}", v.major, v.minor, v.patch + 1)
}

struct RealKindMock {
    mock: MockBackend,
}

macro_rules! delegate_backend {
    ($(fn $name:ident($($arg:ident: $ty:ty),*) $(-> $ret:ty)?;)*) => {
        $(fn $name(&self, $($arg: $ty),*) $(-> $ret)? {
            self.mock.$name($($arg),*)
        })*
    };
}

impl Backend for RealKindMock {
    fn kind(&self) -> BackendKind {
        BackendKind::Real
    }

    delegate_backend! {
        fn defaults() -> Defaults;
        fn set_defaults(defaults: Defaults);
        fn now() -> SystemTime;
        fn probe(cancel: &CancelToken) -> Result<ProbeReport>;
        fn install_cli(method: InstallMethod, log: Events<Line>, cancel: &CancelToken) -> Result<()>;
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
}

struct FakeHttp {
    responses: Mutex<VecDeque<Result<HttpResponse>>>,
    asked: Mutex<Vec<String>>,
}

impl FakeHttp {
    fn new(responses: Vec<Result<HttpResponse>>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            asked: Mutex::new(Vec::new()),
        }
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl HttpClient for FakeHttp {
    fn get(&self, url: &str, _: &[(&str, &str)]) -> Result<HttpResponse> {
        self.asked.lock().unwrap().push(url.to_owned());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected HTTP request")
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn automatic_checks_throttle_for_24h_and_manual_check_refreshes() {
    let dir = tempfile::tempdir().unwrap();
    let (config, clock) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, move |client, backend, store| {
        let t0 = unix_secs(backend.now());
        let first = client.get("/api/updates");
        assert_eq!(first["current_version"], VERSION);
        assert_eq!(first["status"], "up_to_date");
        assert_eq!(first["update_available"], false);
        assert_eq!(first["checked_at"], t0);
        assert_eq!(first["check_updates"], true);
        assert!(first["error"].is_null());
        assert_eq!(backend.update_checks(), 1);
        assert_eq!(store.load().settings.update_checked_at, Some(t0));

        // Repeated automatic checks within 24 hours hit the cache without re-querying.
        assert_eq!(client.get("/api/updates"), first);
        clock.advance(Duration::from_secs(DAY_SECS - 1));
        assert_eq!(client.get("/api/updates"), first);
        assert_eq!(backend.update_checks(), 1);

        // Explicit manual check bypasses the 24h throttle and refreshes both state and timestamp.
        backend.set_failures(MockFailures {
            update_available: true,
            ..Default::default()
        });
        let t1 = unix_secs(backend.now());
        let next = next_patch_version();
        let manual = json(
            client.request("POST", "/api/updates/check", "{}"),
            StatusCode::OK,
        );
        assert_eq!(backend.update_checks(), 2);
        assert_eq!(manual["current_version"], VERSION);
        assert_eq!(manual["status"], "available");
        assert_eq!(manual["update_available"], true);
        assert_eq!(manual["latest_version"], next);
        assert_eq!(
            manual["release_url"],
            format!("https://github.com/321sssrt-bit/colab-playground/releases/tag/v{next}")
        );
        assert_eq!(manual["checked_at"], t1);
        assert!(manual["error"].is_null());
        let saved = store.load().settings;
        assert_eq!(saved.update_checked_at, Some(t1));
        assert_eq!(saved.update_latest.as_deref(), Some(next.as_str()));

        // The 24h window resets from the manual check timestamp.
        clock.advance(Duration::from_secs(DAY_SECS - 1));
        assert_eq!(client.get("/api/updates"), manual);
        assert_eq!(backend.update_checks(), 2);

        clock.advance(Duration::from_secs(1));
        let t2 = unix_secs(backend.now());
        let refreshed = client.get("/api/updates");
        assert_eq!(backend.update_checks(), 3);
        assert_eq!(refreshed["checked_at"], t2);
        assert_eq!(store.load().settings.update_checked_at, Some(t2));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn persisted_daily_throttle_survives_restart_and_clears_stale_latest() {
    let dir = tempfile::tempdir().unwrap();
    let (config, clock) = MockConfig::headless(MockScenario::demo());
    let now = unix_secs(clock.now());
    let checked_at = now.saturating_sub(10 * HOUR_SECS);
    fs::write(
        dir.path().join("settings.json"),
        serde_json::json!({
            "update_checked_at": checked_at,
            "update_latest": "9.0.0",
        })
        .to_string(),
    )
    .unwrap();

    exercise(dir.path(), config, move |client, backend, _| {
        let cached = client.get("/api/updates");
        assert_eq!(backend.update_checks(), 0);
        assert_eq!(cached["current_version"], VERSION);
        assert_eq!(cached["status"], "available");
        assert_eq!(cached["update_available"], true);
        assert_eq!(cached["latest_version"], "9.0.0");
        assert_eq!(
            cached["release_url"],
            "https://github.com/321sssrt-bit/colab-playground/releases/tag/v9.0.0"
        );
        assert_eq!(cached["checked_at"], checked_at);
    })
    .await;

    // A stored `update_latest` no newer than this build is ignored and pruned on the next check.
    let stale_dir = tempfile::tempdir().unwrap();
    let (stale_config, stale_clock) = MockConfig::headless(MockScenario::demo());
    let stale_checked_at = unix_secs(stale_clock.now()).saturating_sub(DAY_SECS + 10);
    fs::write(
        stale_dir.path().join("settings.json"),
        serde_json::json!({
            "update_checked_at": stale_checked_at,
            "update_latest": "0.1.0",
        })
        .to_string(),
    )
    .unwrap();

    exercise(
        stale_dir.path(),
        stale_config,
        move |client, backend, store| {
            let notice = client.get("/api/updates");
            assert_eq!(backend.update_checks(), 1);
            assert_eq!(notice["current_version"], VERSION);
            assert_eq!(notice["status"], "up_to_date");
            assert_eq!(notice["update_available"], false);
            assert!(notice["latest_version"].is_null());
            assert!(notice["release_url"].is_null());
            assert_eq!(store.load().settings.update_latest, None);
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_checks_preserve_version_honor_retry_cooldown_and_keep_checked_at() {
    let dir = tempfile::tempdir().unwrap();
    let (config, clock) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, move |client, backend, store| {
        let t0 = unix_secs(backend.now());
        assert_eq!(client.get("/api/updates")["status"], "up_to_date");
        assert_eq!(backend.update_checks(), 1);

        clock.advance(Duration::from_secs(DAY_SECS));
        backend.set_failures(MockFailures {
            update_check_fails: true,
            ..Default::default()
        });
        let failed = client.get("/api/updates");
        assert_eq!(backend.update_checks(), 2);
        assert_eq!(failed["current_version"], VERSION);
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["update_available"], false);
        assert_eq!(failed["checked_at"], t0);
        assert_eq!(failed["error"]["kind"], "http");
        assert_eq!(store.load().settings.update_checked_at, Some(t0));

        // Automatic retry waits for the 1-hour retry cooldown.
        clock.advance(Duration::from_secs(HOUR_SECS - 1));
        assert_eq!(client.get("/api/updates"), failed);
        assert_eq!(backend.update_checks(), 2);

        // Manual check bypasses the 1-hour cooldown immediately.
        let manual_failed = json(
            client.request("POST", "/api/updates/check", "{}"),
            StatusCode::OK,
        );
        assert_eq!(backend.update_checks(), 3);
        assert_eq!(manual_failed["current_version"], VERSION);
        assert_eq!(manual_failed["status"], "failed");
        assert_eq!(manual_failed["checked_at"], t0);

        // Once the cooldown elapses and the network recovers, the automatic check succeeds.
        backend.set_failures(MockFailures::default());
        clock.advance(Duration::from_secs(HOUR_SECS));
        let t_recovered = unix_secs(backend.now());
        let recovered = client.get("/api/updates");
        assert_eq!(backend.update_checks(), 4);
        assert_eq!(recovered["current_version"], VERSION);
        assert_eq!(recovered["status"], "up_to_date");
        assert_eq!(recovered["checked_at"], t_recovered);
        assert!(recovered["error"].is_null());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_check_off_skips_automatic_checks_while_manual_check_still_runs() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, move |client, backend, store| {
        json(
            client.request("PATCH", "/api/settings", r#"{"check_updates":false}"#),
            StatusCode::OK,
        );

        let idle = client.get("/api/updates");
        assert_eq!(backend.update_checks(), 0);
        assert_eq!(idle["current_version"], VERSION);
        assert_eq!(idle["status"], "idle");
        assert_eq!(idle["update_available"], false);
        assert_eq!(idle["check_updates"], false);
        assert!(idle["checked_at"].is_null());
        assert!(idle["error"].is_null());

        let t0 = unix_secs(backend.now());
        let manual = json(
            client.request("POST", "/api/updates/check", "{}"),
            StatusCode::OK,
        );
        assert_eq!(backend.update_checks(), 1);
        assert_eq!(manual["current_version"], VERSION);
        assert_eq!(manual["status"], "up_to_date");
        assert_eq!(manual["check_updates"], false);
        assert_eq!(manual["checked_at"], t0);
        assert_eq!(store.load().settings.update_checked_at, Some(t0));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn real_backend_handles_no_releases_rate_limit_offline_and_custom_repository() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(Some(dir.path().to_owned()));
    let settings = WebSettings::load(store.clone());
    let (mut config, clock) = MockConfig::headless(MockScenario::demo());
    config.defaults = settings.initial_settings().defaults;
    let backend = Arc::new(RealKindMock {
        mock: MockBackend::new(config),
    });
    let http = Arc::new(FakeHttp::new(vec![
        // 1. Repository has no releases yet (404 -> UpToDate, records checked_at).
        Ok(HttpResponse {
            status: 404,
            body: br#"{"message":"Not Found"}"#.to_vec(),
        }),
        // 2. Manual check hits GitHub API rate limit (403 -> failed, keeps current_version & checked_at).
        Ok(HttpResponse {
            status: 403,
            body: br#"{"message":"API rate limit exceeded"}"#.to_vec(),
        }),
        // 3. Manual check while offline (HttpUnavailable -> failed, keeps current_version).
        Err(Error::new(ErrorKind::HttpUnavailable)),
        // 4. Manual check finds a newer release with an untrusted html_url (sanitised to custom repo).
        Ok(HttpResponse {
            status: 200,
            body: br#"{"tag_name":"v9.2.0","html_url":"https://evil.example/hijack"}"#.to_vec(),
        }),
    ]));
    let repo = UpdateRepository::from_url("https://github.com/acme/custom-fork").unwrap();
    let updates = WebUpdates::with_config(repo, http.clone());
    let http_check = http.clone();

    exercise_backend_with_updates(
        dir.path(),
        store,
        settings,
        updates,
        backend,
        (None, None),
        vec![],
        move |client, backend, store| {
            let t0 = unix_secs(backend.now());
            let no_release = client.get("/api/updates");
            assert_eq!(no_release["current_version"], VERSION);
            assert_eq!(no_release["status"], "up_to_date");
            assert_eq!(no_release["update_available"], false);
            assert_eq!(
                no_release["releases_url"],
                "https://github.com/acme/custom-fork/releases"
            );
            assert_eq!(no_release["checked_at"], t0);
            assert!(no_release["error"].is_null());
            assert_eq!(
                http_check.asked(),
                ["https://api.github.com/repos/acme/custom-fork/releases/latest"]
            );

            // Second automatic check within 24h does not hit the HTTP client.
            clock.advance(Duration::from_secs(HOUR_SECS));
            assert_eq!(client.get("/api/updates"), no_release);
            assert_eq!(http_check.asked().len(), 1);

            let rate_limited = json(
                client.request("POST", "/api/updates/check", "{}"),
                StatusCode::OK,
            );
            assert_eq!(rate_limited["current_version"], VERSION);
            assert_eq!(rate_limited["status"], "failed");
            assert_eq!(rate_limited["checked_at"], t0);
            assert_eq!(rate_limited["error"]["kind"], "rate_limited");
            assert_eq!(store.load().settings.update_checked_at, Some(t0));

            let offline = json(
                client.request("POST", "/api/updates/check", "{}"),
                StatusCode::OK,
            );
            assert_eq!(offline["current_version"], VERSION);
            assert_eq!(offline["status"], "failed");
            assert_eq!(offline["checked_at"], t0);
            assert_eq!(offline["error"]["kind"], "http_unavailable");

            let t1 = unix_secs(backend.now());
            let available = json(
                client.request("POST", "/api/updates/check", "{}"),
                StatusCode::OK,
            );
            assert_eq!(available["current_version"], VERSION);
            assert_eq!(available["status"], "available");
            assert_eq!(available["update_available"], true);
            assert_eq!(available["latest_version"], "9.2.0");
            assert_eq!(
                available["release_url"],
                "https://github.com/acme/custom-fork/releases/latest"
            );
            assert_eq!(available["checked_at"], t1);
            assert!(available["error"].is_null());
            assert_eq!(http_check.asked().len(), 4);
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn background_update_persistence_preserves_corrupt_settings_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("settings.json"), "{ invalid").unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, _, _| {
        let update = client.get("/api/updates");
        assert_eq!(update["status"], "up_to_date");
        assert!(update["checked_at"].is_u64());

        let settings = client.get("/api/settings");
        assert_eq!(settings["load_status"], "corrupt");
        assert!(settings["corrupt_backup"].is_string());
    })
    .await;
}

struct BlockingHttp {
    started: std::sync::mpsc::Sender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
    response: HttpResponse,
    calls: std::sync::atomic::AtomicUsize,
}

impl HttpClient for BlockingHttp {
    fn get(&self, _: &str, _: &[(&str, &str)]) -> Result<HttpResponse> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = self.started.send(());
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .expect("release signal");
        Ok(self.response.clone())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_manual_checks_coalesce_and_disconnects_still_record_throttle() {
    use std::io::Write as _;
    use std::net::TcpStream;
    use std::sync::atomic::Ordering;

    // 1. Disconnecting an in-flight GET still completes and persists the 24h throttle.
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(Some(dir.path().to_owned()));
    let settings = WebSettings::load(store.clone());
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.defaults = settings.initial_settings().defaults;
    let backend = Arc::new(RealKindMock {
        mock: MockBackend::new(config),
    });
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let http = Arc::new(BlockingHttp {
        started: started_tx,
        release: Mutex::new(release_rx),
        response: HttpResponse {
            status: 404,
            body: br#"{"message":"Not Found"}"#.to_vec(),
        },
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    let updates = WebUpdates::with_config(UpdateRepository::default_web(), http.clone());
    let http_check = http.clone();

    exercise_backend_with_updates(
        dir.path(),
        store,
        settings,
        updates,
        backend,
        (None, None),
        vec![],
        move |client, _, store| {
            let addr = client.origin.strip_prefix("http://").unwrap().to_owned();
            let mut raw = TcpStream::connect(&addr).unwrap();
            write!(
                raw,
                "GET /api/updates HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
                client.token
            )
            .unwrap();
            raw.flush().unwrap();

            // Wait until the GitHub request is in flight, then drop the client socket.
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            drop(raw);
            release_tx.send(()).unwrap();

            // The follow-up GET reuses or sees the persisted throttle without a second HTTP call.
            let notice = client.get("/api/updates");
            assert_eq!(notice["current_version"], VERSION);
            assert_eq!(notice["status"], "up_to_date");
            assert!(notice["checked_at"].is_u64());
            assert_eq!(http_check.calls.load(Ordering::SeqCst), 1);
            assert!(store.load().settings.update_checked_at.is_some());
        },
    )
    .await;

    // 2. Two concurrent POST /api/updates/check calls coalesce onto one upstream HTTP request.
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(Some(dir.path().to_owned()));
    let settings = WebSettings::load(store.clone());
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.defaults = settings.initial_settings().defaults;
    let backend = Arc::new(RealKindMock {
        mock: MockBackend::new(config),
    });
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let http = Arc::new(BlockingHttp {
        started: started_tx,
        release: Mutex::new(release_rx),
        response: HttpResponse {
            status: 200,
            body: br#"{"tag_name":"v9.4.0","html_url":"https://github.com/321sssrt-bit/colab-playground/releases/tag/v9.4.0"}"#.to_vec(),
        },
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    let updates = WebUpdates::with_config(UpdateRepository::default_web(), http.clone());
    let http_check = http.clone();

    exercise_backend_with_updates(
        dir.path(),
        store,
        settings,
        updates,
        backend,
        (None, None),
        vec![],
        move |client, _, _| {
            let origin1 = client.origin.clone();
            let token1 = client.token.clone();
            let origin2 = client.origin.clone();
            let token2 = client.token.clone();
            let agent1 = client.agent.clone();
            let agent2 = client.agent.clone();

            let first = std::thread::spawn(move || {
                json(
                    super::request(
                        &agent1,
                        &origin1,
                        "POST",
                        "/api/updates/check",
                        &token1,
                        "{}",
                    ),
                    StatusCode::OK,
                )
            });
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();

            let second = std::thread::spawn(move || {
                json(
                    super::request(
                        &agent2,
                        &origin2,
                        "POST",
                        "/api/updates/check",
                        &token2,
                        "{}",
                    ),
                    StatusCode::OK,
                )
            });
            std::thread::sleep(Duration::from_millis(80));
            release_tx.send(()).unwrap();

            let r1 = first.join().unwrap();
            let r2 = second.join().unwrap();
            assert_eq!(http_check.calls.load(Ordering::SeqCst), 1);
            assert_eq!(r1["status"], "available");
            assert_eq!(r1["latest_version"], "9.4.0");
            assert_eq!(r1, r2);
        },
    )
    .await;
}
