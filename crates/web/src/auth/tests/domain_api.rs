mod forwards;
mod plugins;

use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    sync::Arc,
    time::Duration,
};

use colab_playground_core::{
    backend::Backend,
    mock::{MockBackend, MockConfig, MockFailures, MockScenario},
    sessions::Accelerator,
};
use colab_playground_shared::settings::SettingsStore;
use colab_playground_web::state::{ForwardPolicy, Submission, WebState};
use serde_json::Value;
use ureq::{
    Agent, Body,
    http::{Request, Response, StatusCode},
};

use super::{Auth, KeyStore};
use crate::{
    api::WebSettings,
    http::{Origins, TrustedHost, router},
};

const TIMEOUT: Duration = Duration::from_secs(10);
const INSTALL: &str = "/api/overview/cli/install";

struct Client {
    agent: Agent,
    origin: String,
    token: String,
    web: WebState,
}

impl Client {
    fn request(&self, method: &str, path: &str, body: &str) -> Response<Body> {
        request(&self.agent, &self.origin, method, path, &self.token, body)
    }

    fn get(&self, path: &str) -> Value {
        json(self.request("GET", path, ""), StatusCode::OK)
    }

    fn install(&self) -> BufReader<impl Read + use<>> {
        let response = self.request("POST", INSTALL, r#"{"method":"uv"}"#);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        BufReader::new(response.into_body().into_reader())
    }
}

fn request(
    agent: &Agent,
    origin: &str,
    method: &str,
    path: &str,
    token: &str,
    body: &str,
) -> Response<Body> {
    agent
        .run(
            Request::builder()
                .method(method)
                .uri(format!("{origin}{path}"))
                .header("authorization", format!("Bearer {token}"))
                .header("origin", origin)
                .header("content-type", "application/json")
                .body(body.to_owned())
                .unwrap(),
        )
        .unwrap()
}

fn json(mut response: Response<Body>, status: StatusCode) -> Value {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["content-type"], "application/json");
    serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap()
}

async fn exercise(
    dir: &Path,
    config: MockConfig,
    run: impl FnOnce(Client, Arc<MockBackend>, SettingsStore) + Send + 'static,
) {
    exercise_with_store(dir, SettingsStore::new(Some(dir.to_owned())), config, run).await;
}

async fn exercise_with_store(
    dir: &Path,
    store: SettingsStore,
    config: MockConfig,
    run: impl FnOnce(Client, Arc<MockBackend>, SettingsStore) + Send + 'static,
) {
    exercise_with_policy(dir, store, config, None, vec![], run).await;
}

async fn exercise_with_policy(
    dir: &Path,
    store: SettingsStore,
    mut config: MockConfig,
    policy: Option<ForwardPolicy>,
    trusted: Vec<TrustedHost>,
    run: impl FnOnce(Client, Arc<MockBackend>, SettingsStore) + Send + 'static,
) {
    let settings = WebSettings::load(store.clone());
    config.defaults = settings.initial_settings().defaults;
    let backend = Arc::new(MockBackend::new(config));
    exercise_backend(dir, store, settings, backend, policy, trusted, run).await;
}

async fn exercise_backend<B: Backend + 'static>(
    dir: &Path,
    store: SettingsStore,
    settings: WebSettings,
    backend: Arc<B>,
    policy: Option<ForwardPolicy>,
    trusted: Vec<TrustedHost>,
    run: impl FnOnce(Client, Arc<B>, SettingsStore) + Send + 'static,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let policy = policy.unwrap_or_else(|| crate::platform::forward_policy(addr));
    let web = WebState::start_with_forward_policy(backend.clone(), policy)
        .await
        .unwrap();
    tokio::time::timeout(
        TIMEOUT,
        web.subscribe().wait_for(|snapshot| {
            (snapshot.accounts.is_some() || snapshot.accounts_error.is_some())
                && (snapshot.runtimes.is_some() || snapshot.runtimes_error.is_some())
        }),
    )
    .await
    .unwrap()
    .unwrap();
    let keys = KeyStore::new(dir);
    let _lock = colab_playground_core::InstanceLock::acquire(keys.dir()).unwrap();
    let key = keys.replace().unwrap();
    let (_watcher, changes) = keys.watch();
    let app = router(
        Auth::new(keys),
        changes,
        Origins::new(addr, trusted),
        web.clone(),
        settings,
    );
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });

    let client_web = web.clone();
    let result = tokio::task::spawn_blocking(move || {
        let agent: Agent = Agent::config_builder()
            .proxy(None)
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .into();
        let origin = format!("http://{addr}");
        assert_eq!(
            request(&agent, &origin, "GET", "/api/overview", "", "").status(),
            StatusCode::UNAUTHORIZED
        );
        let credentials = json(
            request(
                &agent,
                &origin,
                "POST",
                "/api/login",
                "",
                &serde_json::json!({"access_key": key}).to_string(),
            ),
            StatusCode::OK,
        );
        run(
            Client {
                agent,
                origin,
                token: credentials["token"].as_str().unwrap().to_owned(),
                web: client_web,
            },
            backend,
            store,
        );
    })
    .await;
    server.abort();
    web.shutdown(TIMEOUT).await;
    result.unwrap();
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn next_event(reader: &mut impl BufRead) -> (String, Value) {
    let mut name = String::new();
    let mut data = None;
    loop {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0, "SSE ended");
        if let Some(value) = line.trim_end().strip_prefix("event: ") {
            name = value.into();
        }
        if let Some(value) = line.trim_end().strip_prefix("data: ") {
            data = Some(serde_json::from_str(value).unwrap());
        }
        if line.trim_end().is_empty()
            && let Some(value) = data.take()
        {
            return (name, value);
        }
    }
}

fn event(reader: &mut impl BufRead, expected: &str) -> Value {
    let mut field = String::new();
    loop {
        assert_ne!(
            reader.read_line(&mut field).unwrap(),
            0,
            "stream ended before {expected}"
        );
        if !field.starts_with(':') && !field.trim().is_empty() {
            break;
        }
        field.clear();
    }
    assert_eq!(field.trim_end(), format!("event: {expected}"));
    field.clear();
    reader.read_line(&mut field).unwrap();
    let payload = serde_json::from_str(field.strip_prefix("data: ").unwrap()).unwrap();
    field.clear();
    reader.read_line(&mut field).unwrap();
    assert!(field.trim().is_empty());
    payload
}

#[tokio::test(flavor = "multi_thread")]
async fn overview_updates_and_all_dictionaries() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.failures.update_available = true;
    exercise(dir.path(), config, |client, backend, _| {
        let overview = client.get("/api/overview");
        assert_eq!(overview["environment"]["colab_version"], "0.8.0");
        assert!(overview["environment"]["helper_python"].is_string());
        assert_eq!(overview["keyring"]["status"], "ready");
        assert_eq!(
            overview["accounts"]["accounts"].as_array().unwrap().len(),
            2
        );
        assert!(overview["accounts"]["active"].is_string());
        assert_eq!(overview["unmanaged_runtimes"]["count"], 1);
        assert_eq!(overview["unmanaged_runtimes"]["incomplete"], false);

        let update = client.get("/api/updates");
        assert_eq!(
            update,
            serde_json::json!({
                "current_version": env!("CARGO_PKG_VERSION"),
                "update_available": true,
                "releases_url": "https://github.com/321sssrt-bit/colab-playground/releases",
            })
        );
        assert_eq!(
            client.request("POST", "/api/updates", "{}").status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            client
                .request("POST", "/api/updates/install", "{}")
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(backend.update_checks(), 1);
        assert_eq!(backend.update_installs(), 0);
        assert_eq!(backend.update_relaunches(), 0);

        let mut english = None;
        for (tag, shared) in colab_playground_shared::i18n::CATALOGS {
            let dictionary = client.get(&format!("/api/i18n/{tag}"));
            let dictionary = dictionary.as_object().unwrap();
            let keys = dictionary.keys().cloned().collect::<Vec<_>>();
            assert_eq!(english.get_or_insert_with(|| keys.clone()), &keys);
            assert!(dictionary.len() > shared.len());
            for (key, message) in shared {
                assert_eq!(&dictionary[*key], *message);
            }
            assert!(dictionary["dialog.cancel"].is_string());
            assert!(dictionary["theme.system"].is_string());
        }
        let bad_locale = json(
            client.request("GET", "/api/i18n/fr-FR", ""),
            StatusCode::NOT_FOUND,
        );
        assert_eq!(bad_locale["error"]["kind"], "locale_not_found");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_recover_per_field_and_keep_desktop_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_owned();
    fs::write(
        path.join("settings.json"),
        r#"{
        "language":"xx", "appearance":"dark", "colab_path": "/some/colab",
        "update_latest":"9.0.0", "defaults":{"max_attempts":"invalid","retry_delay":45}
    }"#,
    )
    .unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, move |client, backend, store| {
        let settings = client.get("/api/settings");
        assert_eq!(settings["language"], "system");
        assert_eq!(settings["appearance"], "dark");
        assert_eq!(
            settings["reset_defaults"],
            serde_json::json!(["max_attempts"])
        );
        assert_eq!(settings["defaults"]["retry_delay"], 45);
        assert_eq!(settings["config_dir"], path.to_string_lossy().as_ref());

        let updated = json(
            client.request(
                "PATCH",
                "/api/settings",
                r#"{"language":"ja-JP","defaults":{"max_attempts":5,"idle_timeout":0}}"#,
            ),
            StatusCode::OK,
        );
        assert_eq!(updated["language"], "ja-JP");
        assert_eq!(updated["defaults"]["idle_timeout"], 1);
        assert_eq!(updated["defaults"]["retry_delay"], 45);
        let saved = store.load().settings;
        assert_eq!(saved.defaults, backend.defaults());
        assert_eq!(saved.colab_path.as_deref(), Some("/some/colab"));
        assert_eq!(saved.update_latest.as_deref(), Some("9.0.0"));
        assert_eq!(updated, client.get("/api/settings"));

        let invalid = json(
            client.request(
                "PATCH",
                "/api/settings",
                r#"{"appearance":"light","defaults":{"high_mem":"yes"}}"#,
            ),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
        assert_eq!(invalid["error"]["kind"], "invalid_input");
        assert_eq!(store.load().settings, saved);
        assert_eq!(client.get("/api/settings"), updated);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn corrupt_settings_survive_and_failed_writes_do_not_change_defaults() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("settings.json"), "{ invalid").unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, backend, store| {
        let settings = client.get("/api/settings");
        assert_eq!(settings["load_status"], "corrupt");
        let backup = settings["corrupt_backup"].as_str().unwrap();
        assert_eq!(fs::read_to_string(backup).unwrap(), "{ invalid");

        let file = store.file().unwrap();
        fs::create_dir(&file).unwrap();
        let error = json(
            client.request(
                "PATCH",
                "/api/settings",
                r#"{"defaults":{"max_attempts":5}}"#,
            ),
            StatusCode::INTERNAL_SERVER_ERROR,
        );
        assert_eq!(error["error"]["kind"], "io");
        assert_eq!(backend.defaults(), Default::default());
        assert_eq!(client.get("/api/settings"), settings);
        fs::remove_dir(file).unwrap();

        let saved = json(
            client.request("PATCH", "/api/settings", r#"{"appearance":"light"}"#),
            StatusCode::OK,
        );
        assert_eq!(saved["load_status"], "loaded");
        assert_eq!(saved["appearance"], "light");
        assert_eq!(fs::read_to_string(backup).unwrap(), "{ invalid");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cli_install_streams_deduplicates_cancels_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = MockConfig::interactive(Duration::from_millis(300));
    config.failures.cli_missing = true;
    exercise(dir.path(), config, |client, _, _| {
        assert_eq!(client.get("/api/overview")["cli_installed"], false);
        let mut reader = client.install();
        let id = event(&mut reader, "started")["id"].as_u64().unwrap();
        assert_eq!(event(&mut reader, "line")["stream"], "stdout");
        let duplicate = json(
            client.request("POST", INSTALL, r#"{"method":"pip_user"}"#),
            StatusCode::CONFLICT,
        );
        assert_eq!(duplicate["error"]["operation_id"], id);
        assert_eq!(
            client
                .request("POST", &format!("{INSTALL}/{id}/cancel"), "{}")
                .status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(event(&mut reader, "finished")["status"], "cancelled");
        assert_eq!(client.get("/api/overview")["cli_installed"], false);

        let mut reader = client.install();
        let detached = event(&mut reader, "started")["id"].as_u64().unwrap();
        drop(reader);
        assert!(
            client.get("/api/snapshot")["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|job| job["id"] == detached)
        );
        assert_eq!(
            client
                .request("POST", &format!("{INSTALL}/{detached}/cancel"), "{}")
                .status(),
            StatusCode::ACCEPTED
        );
        // The first cancel request returns before cleanup releases the install slot.
        let deadline = std::time::Instant::now() + TIMEOUT;
        while client.get("/api/snapshot")["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|job| job["id"] == detached)
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }

        let mut reader = client.install();
        assert_ne!(event(&mut reader, "started")["id"], id);
        for _ in 0..5 {
            assert_eq!(event(&mut reader, "line")["stream"], "stdout");
        }
        assert_eq!(event(&mut reader, "finished")["status"], "succeeded");
        assert_eq!(client.get("/api/overview")["cli_installed"], true);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keyring_update_and_install_failures_have_localizable_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.failures = MockFailures {
        keyring_unavailable: true,
        install_fails: true,
        update_check_fails: true,
        ..Default::default()
    };
    exercise(dir.path(), config, |client, backend, _| {
        let overview = client.get("/api/overview");
        assert_eq!(overview["keyring"]["status"], "unavailable");
        assert_eq!(overview["accounts_error"], "keyring_unavailable");
        assert!(overview["unmanaged_runtimes"]["warning_key"].is_null());
        let hint = overview["keyring"]["hint_key"].as_str().unwrap();
        let dictionary = client.get("/api/i18n/en-US");
        assert!(dictionary[hint].as_str().unwrap().contains("keyring"));
        if crate::platform::headless_secret_service() {
            assert!(
                dictionary[hint]
                    .as_str()
                    .unwrap()
                    .contains("Secret Service")
            );
        }
        let error = json(
            client.request("GET", "/api/updates", ""),
            StatusCode::BAD_GATEWAY,
        );
        assert_eq!(error["error"]["kind"], "http");
        let mut reader = client.install();
        event(&mut reader, "started");
        for _ in 0..4 {
            event(&mut reader, "line");
        }
        assert_eq!(event(&mut reader, "line")["stream"], "stderr");
        let failed = event(&mut reader, "finished");
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["error"]["kind"], "install_failed");
        assert_eq!(failed["error"]["args"]["exit_code"], "2");
        backend.set_failures(MockFailures::default());
        let recovered = client.get("/api/overview");
        assert_eq!(recovered["keyring"]["status"], "ready");
        assert_eq!(recovered["usage"].as_array().unwrap().len(), 2);
        assert_eq!(recovered["unmanaged_runtimes"]["count"], 1);

        backend.set_failures(MockFailures {
            cli_missing: true,
            ..Default::default()
        });
        let missing = client.get("/api/overview");
        assert_eq!(missing["cli_installed"], false);
        assert!(missing["accounts"].is_null());
        assert_eq!(missing["usage"], serde_json::json!([]));
        assert!(missing["unmanaged_runtimes"]["warning_key"].is_null());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn overview_reports_which_accounts_could_not_be_checked() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config
        .failures
        .unlisted_accounts
        .push("ada@example.com".into());
    exercise(dir.path(), config, |client, backend, _| {
        let overview = client.get("/api/overview");
        let runtimes = &overview["unmanaged_runtimes"];
        assert!(runtimes["count"].is_null());
        assert_eq!(runtimes["incomplete"], true);
        assert_eq!(
            runtimes["unverified_accounts"],
            serde_json::json!([overview["accounts"]["active"]])
        );
        assert_eq!(runtimes["warning_key"], "web.runtimes.unmanaged_unknown");
        backend.set_failures(MockFailures::default());
        let recovered = client.get("/api/overview");
        assert_eq!(recovered["unmanaged_runtimes"]["count"], 1);
        assert_eq!(
            recovered["unmanaged_runtimes"]["unverified_accounts"],
            serde_json::json!([])
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_without_a_config_directory_remain_live_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise_with_store(
        dir.path(),
        SettingsStore::new(None),
        config,
        |client, backend, store| {
            let settings = json(
                client.request(
                    "PATCH",
                    "/api/settings",
                    r#"{"appearance":"dark","defaults":{"max_attempts":5}}"#,
                ),
                StatusCode::OK,
            );
            assert_eq!(settings["load_status"], "no_config_dir");
            assert!(settings["config_dir"].is_null());
            assert_eq!(settings["appearance"], "dark");
            assert_eq!(backend.defaults().max_attempts, 5);
            assert!(store.file().is_none());
            assert_eq!(client.get("/api/settings"), settings);
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn overview_retries_failed_usage_within_the_poll_cooldown() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.failures.usage_fetch_fails = true;
    exercise(dir.path(), config, |client, backend, _| {
        let failed = client.get("/api/overview");
        assert!(failed["usage"][0]["last_error"].is_object());
        backend.set_failures(MockFailures::default());
        assert!(!backend.usage_poll_due());

        let recovered = client.get("/api/overview");
        assert!(recovered["usage"][0]["last_error"].is_null());
        assert_eq!(recovered["usage"][0]["snapshot"]["stale"], false);
        assert!(recovered["usage"][0]["snapshot"]["balance_cu"].is_number());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn overview_refreshes_usage_and_runtime_counts_after_login() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, backend, _| {
        let runtime = tokio::runtime::Handle::current();
        let account = client.web.snapshot().account.clone();
        let Submission::Started { job, .. } = client.web.begin_login(account).unwrap() else {
            panic!("expected login to start");
        };
        let prompt = runtime.block_on(job).unwrap().unwrap();
        assert_eq!(
            client.request("GET", "/api/overview", "").status(),
            StatusCode::CONFLICT
        );
        let Submission::Started { job, .. } = client
            .web
            .submit_login(prompt.id, "demo-code".into())
            .unwrap()
        else {
            panic!("expected login to complete");
        };
        let account = runtime.block_on(job).unwrap().unwrap().unwrap();
        backend.add_unmanaged_runtime(&account.id, Accelerator::None);

        let overview = client.get("/api/overview");
        assert_eq!(overview["accounts"]["active"], account.id.as_str());
        let usage = overview["usage"]
            .as_array()
            .unwrap()
            .iter()
            .find(|view| view["account"] == account.id.as_str())
            .unwrap();
        assert_eq!(usage["snapshot"]["assignments"], 1);
        assert_eq!(overview["unmanaged_runtimes"]["count"], 2);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn overview_refreshes_even_after_background_poll_recovers_accounts() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, backend, _| {
        let overview = client.get("/api/overview");
        assert_eq!(overview["unmanaged_runtimes"]["count"], 1);
        let active = client.web.snapshot().account.active.clone().unwrap();
        let listed = backend.runtime_listings();
        backend.set_failures(MockFailures {
            keyring_unavailable: true,
            ..Default::default()
        });
        assert_eq!(
            client.get("/api/overview")["keyring"]["status"],
            "unavailable"
        );
        backend.add_unmanaged_runtime(&active, Accelerator::None);
        backend.set_failures(MockFailures::default());
        assert!(!backend.usage_poll_due());

        tokio::runtime::Handle::current().block_on(async {
            tokio::time::timeout(
                TIMEOUT,
                client
                    .web
                    .subscribe()
                    .wait_for(|snapshot| snapshot.accounts_error.is_none()),
            )
            .await
            .unwrap()
            .unwrap();
        });
        assert_eq!(backend.runtime_listings(), listed);

        let recovered = client.get("/api/overview");
        assert_eq!(recovered["keyring"]["status"], "ready");
        assert_eq!(recovered["usage"][0]["snapshot"]["assignments"], 4);
        assert_eq!(recovered["unmanaged_runtimes"]["count"], 2);
    })
    .await;
}
