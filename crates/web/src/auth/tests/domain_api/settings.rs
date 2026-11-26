use std::{
    fs,
    io::BufReader,
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

use colab_playground_core::{
    Error, ErrorKind,
    backend::Backend,
    mock::{MockBackend, MockConfig, MockFailures, MockScenario},
};
use colab_playground_shared::{
    i18n::keys,
    settings::{Settings, SettingsStore},
};
use colab_playground_web::state::Access;
use ureq::http::StatusCode;

use super::{INSTALL, TIMEOUT, event, exercise, exercise_backend, json, next_event};
use crate::api::{BackendBuilder, WebSettings};

#[tokio::test(flavor = "multi_thread")]
async fn check_updates_defaults_on_and_persists_across_reloads() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, _, store| {
        let initial = client.get("/api/settings");
        assert_eq!(initial["check_updates"], true);

        let disabled = json(
            client.request("PATCH", "/api/settings", r#"{"check_updates":false}"#),
            StatusCode::OK,
        );
        assert_eq!(disabled["check_updates"], false);
        assert!(!store.load().settings.check_updates.0);

        // Patching unrelated fields preserves the persisted auto-check toggle.
        let themed = json(
            client.request("PATCH", "/api/settings", r#"{"appearance":"dark"}"#),
            StatusCode::OK,
        );
        assert_eq!(themed["appearance"], "dark");
        assert_eq!(themed["check_updates"], false);
        assert!(!WebSettings::load(store.clone()).current().check_updates.0);

        let invalid = json(
            client.request("PATCH", "/api/settings", r#"{"check_updates":"yes"}"#),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
        assert_eq!(invalid["error"]["kind"], "invalid_request");
        assert!(!store.load().settings.check_updates.0);

        let reenabled = json(
            client.request("PATCH", "/api/settings", r#"{"check_updates":true}"#),
            StatusCode::OK,
        );
        assert_eq!(reenabled["check_updates"], true);
        assert!(store.load().settings.check_updates.0);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn corrupt_check_updates_field_falls_back_to_true() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("settings.json"),
        r#"{"check_updates":"invalid","appearance":"dark"}"#,
    )
    .unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, _, _| {
        let settings = client.get("/api/settings");
        assert_eq!(settings["check_updates"], true);
        assert_eq!(settings["appearance"], "dark");
    })
    .await;
    let reloaded = SettingsStore::new(Some(dir.path().to_owned())).load();
    assert!(reloaded.settings.check_updates.0);
}

#[tokio::test(flavor = "multi_thread")]
async fn host_settings_hot_rebuild_clears_install_state_and_validates_interpreter_rule() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(Some(dir.path().to_owned()));
    type HostTuple = (Option<String>, Option<String>, Option<String>);
    let built_configs: Arc<Mutex<Vec<HostTuple>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = built_configs.clone();
    let builder: BackendBuilder = Arc::new(move |settings: &Settings| {
        recorded.lock().unwrap().push((
            settings.wsl_distro.clone(),
            settings.colab_path.clone(),
            settings.colab_python.clone(),
        ));
        let (mut config, _) = MockConfig::headless(MockScenario::single());
        config.defaults = settings.defaults.clone();
        config.failures.cli_missing = settings.colab_path.as_deref() != Some("/venv/bin/colab");
        Ok(Arc::new(MockBackend::new(config)) as Arc<dyn Backend>)
    });
    let settings = WebSettings::load(store.clone()).with_backend_builder(builder);
    let (mut initial_config, _) = MockConfig::headless(MockScenario::signed_out());
    initial_config.failures.cli_missing = true;
    initial_config.failures.install_off_path = true;
    let initial_backend = Arc::new(MockBackend::new(initial_config));

    let expected_file = store.file().unwrap().to_string_lossy().into_owned();
    exercise_backend(
        dir.path(),
        store,
        settings,
        initial_backend,
        (None, None),
        vec![],
        move |client, _, store| {
            let initial = client.get("/api/settings");
            assert_eq!(initial["settings_file"], expected_file);
            assert!(initial["wsl_distro"].is_null());
            assert!(initial["colab_path"].is_null());
            assert!(initial["colab_python"].is_null());
            assert_eq!(initial["uses_wsl"], crate::platform::uses_wsl());

            // Off-path install settles to `not_found`, never `succeeded`.
            let mut reader = client.install();
            let id = event(&mut reader, "started")["id"].as_u64().unwrap();
            for _ in 0..5 {
                assert_eq!(event(&mut reader, "line")["stream"], "stdout");
            }
            let warn_line = event(&mut reader, "line");
            assert_eq!(warn_line["stream"], "stderr");
            assert!(
                warn_line["text"]
                    .as_str()
                    .unwrap()
                    .contains("not on your PATH")
            );
            let finished = event(&mut reader, "finished");
            assert_eq!(finished["status"], "not_found");
            assert_eq!(finished["cli_installed"], false);
            assert_eq!(finished["warning_title_key"], keys::INSTALL_NOT_FOUND_TITLE);
            assert_eq!(finished["warning_body_key"], keys::INSTALL_NOT_FOUND_BODY);
            assert!(finished["error"].is_null());

            let overview = client.get("/api/overview");
            assert_eq!(overview["cli_installed"], false);
            assert_eq!(overview["cli_install"]["id"], id);
            assert_eq!(overview["cli_install"]["phase"], "not_found");
            assert_eq!(overview["cli_install"]["lines"].as_array().unwrap().len(), 6);
            assert_eq!(
                overview["cli_install"]["warning_title_key"],
                keys::INSTALL_NOT_FOUND_TITLE
            );

            // Setting python without colab_path is rejected with HOST_INTERPRETER_ALONE.
            let rejected = json(
                client.request(
                    "PATCH",
                    "/api/settings",
                    r#"{"colab_python":"/venv/bin/python"}"#,
                ),
                StatusCode::UNPROCESSABLE_ENTITY,
            );
            assert_eq!(rejected["error"]["kind"], "invalid_input");
            assert_eq!(rejected["error"]["message_key"], keys::HOST_INTERPRETER_ALONE);
            assert!(built_configs.lock().unwrap().is_empty());
            assert_eq!(
                client.get("/api/overview/cli/install")["phase"],
                "not_found"
            );

            // Setting trimmed host paths triggers atomic backend rebuild and clears install state.
            let updated = json(
                client.request(
                    "PATCH",
                    "/api/settings",
                    r#"{"wsl_distro":" Ubuntu-24.04 ","colab_path":" /venv/bin/colab ","colab_python":" /venv/bin/python "}"#,
                ),
                StatusCode::OK,
            );
            assert_eq!(updated["wsl_distro"], "Ubuntu-24.04");
            assert_eq!(updated["colab_path"], "/venv/bin/colab");
            assert_eq!(updated["colab_python"], "/venv/bin/python");
            let saved = store.load().settings;
            assert_eq!(saved.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
            assert_eq!(saved.colab_path.as_deref(), Some("/venv/bin/colab"));
            assert_eq!(saved.colab_python.as_deref(), Some("/venv/bin/python"));

            let recorded = built_configs.lock().unwrap().clone();
            assert_eq!(
                recorded,
                vec![(
                    Some("Ubuntu-24.04".into()),
                    Some("/venv/bin/colab".into()),
                    Some("/venv/bin/python".into()),
                )]
            );
            let cleared_install = client.get("/api/overview/cli/install");
            assert_eq!(cleared_install["phase"], "idle");
            assert!(cleared_install["id"].is_null());
            assert_eq!(cleared_install["lines"], serde_json::json!([]));
            assert_eq!(
                client.request("POST", &format!("{INSTALL}/events"), "{}").status(),
                StatusCode::NOT_FOUND
            );

            // The rebuilt backend is active immediately on /api/overview.
            let rebuilt_overview = client.get("/api/overview");
            assert_eq!(rebuilt_overview["cli_installed"], true);
            assert_eq!(rebuilt_overview["cli_install"]["phase"], "idle");
            assert_eq!(
                rebuilt_overview["accounts"]["accounts"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );

            // Clearing colab_path while keeping colab_python is rejected.
            let clear_path_only = json(
                client.request("PATCH", "/api/settings", r#"{"colab_path":"   "}"#),
                StatusCode::UNPROCESSABLE_ENTITY,
            );
            assert_eq!(
                clear_path_only["error"]["message_key"],
                keys::HOST_INTERPRETER_ALONE
            );

            // Clearing all host fields succeeds and rebuilds back to cli_missing.
            let cleared = json(
                client.request(
                    "PATCH",
                    "/api/settings",
                    r#"{"wsl_distro":"","colab_path":null,"colab_python":""}"#,
                ),
                StatusCode::OK,
            );
            assert!(cleared["wsl_distro"].is_null());
            assert!(cleared["colab_path"].is_null());
            assert!(cleared["colab_python"].is_null());
            assert_eq!(client.get("/api/overview")["cli_installed"], false);
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn host_settings_patch_rejects_busy_and_rolls_back_on_builder_error() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(Some(dir.path().to_owned()));
    let fail_build = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let fail_flag = fail_build.clone();
    let builder: BackendBuilder = Arc::new(move |_| {
        if fail_flag.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::new(ErrorKind::Io).detail("simulated rebuild failure"));
        }
        let (config, _) = MockConfig::headless(MockScenario::demo());
        Ok(Arc::new(MockBackend::new(config)) as Arc<dyn Backend>)
    });
    let settings = WebSettings::load(store.clone()).with_backend_builder(builder);
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.failures.cli_missing = true;
    config.failures.install_off_path = true;
    let backend = Arc::new(MockBackend::new(config));

    exercise_backend(
        dir.path(),
        store,
        settings,
        backend,
        (None, None),
        vec![],
        move |client, _, store| {
            // Seed install state first.
            let mut reader = client.install();
            event(&mut reader, "started");
            for _ in 0..6 {
                event(&mut reader, "line");
            }
            assert_eq!(event(&mut reader, "finished")["status"], "not_found");

            // While another operation is active, host changes return 409 Busy, while non-host succeeds.
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let _blocker = client
                .web
                .start_operation(
                    "busy_op",
                    String::new(),
                    Access::Independent,
                    move |_, _| {
                        let _ = entered_tx.send(());
                        let _ = release_rx.recv_timeout(TIMEOUT);
                        Ok(())
                    },
                )
                .unwrap();
            entered_rx.recv_timeout(TIMEOUT).unwrap();

            let busy = json(
                client.request("PATCH", "/api/settings", r#"{"colab_path":"/opt/colab"}"#),
                StatusCode::CONFLICT,
            );
            assert_eq!(busy["error"]["kind"], "busy");
            assert!(store.load().settings.colab_path.is_none());

            let non_host = json(
                client.request("PATCH", "/api/settings", r#"{"appearance":"dark"}"#),
                StatusCode::OK,
            );
            assert_eq!(non_host["appearance"], "dark");

            release_tx.send(()).unwrap();
            let deadline = std::time::Instant::now() + TIMEOUT;
            while !client.web.can_change_host() {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }

            // Builder error rolls back cleanly: disk, backend, and cli_install stay intact.
            let failed = json(
                client.request("PATCH", "/api/settings", r#"{"colab_path":"/opt/colab"}"#),
                StatusCode::INTERNAL_SERVER_ERROR,
            );
            assert_eq!(failed["error"]["kind"], "io");
            assert!(store.load().settings.colab_path.is_none());
            assert_eq!(
                client.get("/api/overview/cli/install")["phase"],
                "not_found"
            );
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cli_install_sse_replays_after_disconnect_and_resolves_after_check_again() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = MockConfig::interactive(Duration::from_millis(120));
    config.failures.cli_missing = true;
    config.failures.install_off_path = true;
    exercise(dir.path(), config, |client, backend, _| {
        assert_eq!(
            client
                .request("POST", &format!("{INSTALL}/events"), "{}")
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .request("POST", &format!("{INSTALL}/bad-id/events"), "{}")
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let mut reader = client.install();
        let id = event(&mut reader, "started")["id"].as_u64().unwrap();
        let first = event(&mut reader, "line");
        // Client disconnects mid-install.
        drop(reader);

        // Reconnect by install id: replays from line 0 through completion.
        let response = client.request("POST", &format!("{INSTALL}/{id}/events"), "{}");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let mut replay = BufReader::new(response.into_body().into_reader());
        assert_eq!(event(&mut replay, "started")["id"], id);
        let mut lines = Vec::new();
        for _ in 0..6 {
            lines.push(event(&mut replay, "line"));
        }
        assert_eq!(lines[0], first);
        assert_eq!(lines[5]["stream"], "stderr");
        let finished = event(&mut replay, "finished");
        assert_eq!(finished["status"], "not_found");
        assert_eq!(finished["cli_installed"], false);
        assert_eq!(finished["warning_title_key"], keys::INSTALL_NOT_FOUND_TITLE);
        assert_eq!(finished["warning_body_key"], keys::INSTALL_NOT_FOUND_BODY);

        // Reconnect after finish via latest endpoint: replays full log and terminal status.
        let response = client.request("POST", &format!("{INSTALL}/events"), "{}");
        assert_eq!(response.status(), StatusCode::OK);
        let mut late = BufReader::new(response.into_body().into_reader());
        assert_eq!(event(&mut late, "started")["id"], id);
        for expected in &lines {
            assert_eq!(&event(&mut late, "line"), expected);
        }
        assert_eq!(event(&mut late, "finished")["status"], "not_found");
        assert_eq!(
            client
                .request("POST", &format!("{INSTALL}/999999/events"), "{}")
                .status(),
            StatusCode::NOT_FOUND
        );

        // Once colab is placed on PATH, Check again (GET /api/overview) settles to succeeded.
        backend.set_failures(MockFailures::default());
        let recovered = client.get("/api/overview");
        assert_eq!(recovered["cli_installed"], true);
        assert_eq!(recovered["cli_install"]["phase"], "succeeded");
        assert!(recovered["cli_install"]["warning_title_key"].is_null());
        assert!(recovered["cli_install"]["warning_body_key"].is_null());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_file_path_and_one_time_corrupt_notice_consumption() {
    let dir = tempfile::tempdir().unwrap();
    let settings_file = dir.path().join("settings.json");
    fs::write(&settings_file, "{ invalid json").unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, move |client, _, _| {
        let initial_snapshot = client.get("/api/snapshot");
        assert_eq!(initial_snapshot["settings_notice"]["corrupt"], true);
        let backup = initial_snapshot["settings_notice"]["corrupt_backup"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            initial_snapshot["settings_notice"]["reset_defaults"],
            serde_json::json!([])
        );

        let initial_settings = client.get("/api/settings");
        assert_eq!(
            initial_settings["settings_file"],
            settings_file.to_string_lossy().as_ref()
        );
        assert_eq!(
            initial_settings["settings_notice"],
            initial_snapshot["settings_notice"]
        );
        // GET is idempotent and does not consume the notice prematurely.
        assert_eq!(client.get("/api/settings"), initial_settings);

        let events_response = client.request("POST", "/api/events", "{}");
        assert_eq!(events_response.status(), StatusCode::OK);
        let mut sse = BufReader::new(events_response.into_body().into_reader());
        let (name, first_frame) = next_event(&mut sse);
        assert_eq!(name, "snapshot");
        assert_eq!(first_frame["settings_notice"]["corrupt"], true);

        // First dismiss consumes and returns the startup notice once.
        let consumed = json(
            client.request("POST", "/api/settings/notice/dismiss", "{}"),
            StatusCode::OK,
        );
        assert_eq!(consumed["notice"]["corrupt"], true);
        assert_eq!(consumed["notice"]["corrupt_backup"], backup);

        // SSE subscribers observe the cleared notice immediately.
        let (name, cleared_frame) = next_event(&mut sse);
        assert_eq!(name, "snapshot");
        assert!(cleared_frame["settings_notice"].is_null());

        // Subsequent dismiss and reads see null.
        let second = json(
            client.request("POST", "/api/settings/notice/dismiss", "{}"),
            StatusCode::OK,
        );
        assert!(second["notice"].is_null());
        assert!(client.get("/api/snapshot")["settings_notice"].is_null());
        assert!(client.get("/api/settings")["settings_notice"].is_null());
        assert_eq!(
            client.get("/api/settings")["settings_file"],
            settings_file.to_string_lossy().as_ref()
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reset_defaults_startup_notice_is_consumed_once() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("settings.json"),
        r#"{"defaults":{"max_attempts":"invalid"}}"#,
    )
    .unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, _, _| {
        let snap = client.get("/api/snapshot");
        assert_eq!(snap["settings_notice"]["corrupt"], false);
        assert!(snap["settings_notice"]["corrupt_backup"].is_null());
        assert_eq!(
            snap["settings_notice"]["reset_defaults"],
            serde_json::json!(["max_attempts"])
        );

        let first = json(
            client.request("POST", "/api/settings/notice/dismiss", "{}"),
            StatusCode::OK,
        );
        assert_eq!(
            first["notice"]["reset_defaults"],
            serde_json::json!(["max_attempts"])
        );
        let second = json(
            client.request("POST", "/api/settings/notice/dismiss", "{}"),
            StatusCode::OK,
        );
        assert!(second["notice"].is_null());
        assert!(client.get("/api/snapshot")["settings_notice"].is_null());
        assert!(client.get("/api/settings")["settings_notice"].is_null());
    })
    .await;
}
