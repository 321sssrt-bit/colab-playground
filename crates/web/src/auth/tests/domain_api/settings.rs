use std::fs;

use colab_playground_core::mock::{MockConfig, MockScenario};
use colab_playground_shared::settings::SettingsStore;
use ureq::http::StatusCode;

use super::{exercise, json};
use crate::api::WebSettings;

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
