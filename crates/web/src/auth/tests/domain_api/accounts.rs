use colab_playground_core::{CancelToken, guard::USAGE_STALE_AFTER, mock::MockLoginFailure};
use serde_json::json;

use super::*;

const ACCOUNTS: &str = "/api/accounts";
const LOGIN: &str = "/api/accounts/login";
const REFRESH: &str = "/api/accounts/usage/refresh";

fn events(client: &Client) -> BufReader<impl Read + use<>> {
    let response = client.request("POST", "/api/events", "{}");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    BufReader::new(response.into_body().into_reader())
}

fn snapshot_when(reader: &mut impl BufRead, matches: impl Fn(&Value) -> bool) -> Value {
    loop {
        let (name, snapshot) = next_event(reader);
        if name == "snapshot" && matches(&snapshot) {
            return snapshot;
        }
    }
}

fn mutate(client: &Client, path: &str, body: &Value, status: StatusCode) -> Value {
    json(client.request("POST", path, &body.to_string()), status)
}

fn account_action(client: &Client) -> Value {
    json!({"account_context": client.get(ACCOUNTS)["account_context"]})
}

fn begin_login(client: &Client) -> Value {
    let prompt = mutate(client, LOGIN, &account_action(client), StatusCode::CREATED);
    assert_eq!(
        url::Url::parse(prompt["auth_url"].as_str().unwrap())
            .unwrap()
            .origin()
            .ascii_serialization(),
        "https://accounts.google.com"
    );
    prompt["id"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_preserves_the_cli_slot_and_distinguishes_unknown_stale_and_fresh() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.failures.usage_fetch_fails = true;
    exercise(dir.path(), config, |client, backend, _| {
        let mut stream = events(&client);
        let before = client.get(ACCOUNTS);
        let active = before["account_context"].clone();
        assert_eq!(before["accounts"]["accounts"].as_array().unwrap().len(), 2);
        let unknown = mutate(&client, REFRESH, &json!({}), StatusCode::OK);
        assert_eq!(unknown["usage"].as_array().unwrap().len(), 2);
        for account in unknown["usage"].as_array().unwrap() {
            assert!(account["snapshot"].is_null());
            assert!(account["eta"].is_null());
            assert_eq!(account["last_error"]["kind"], "http");
        }
        backend.set_failures(MockFailures::default());
        let fresh = mutate(&client, REFRESH, &json!({}), StatusCode::OK);
        assert_eq!(fresh["account_context"], active);
        for (account, balance) in fresh["usage"].as_array().unwrap().iter().zip([87.5, 240.0]) {
            assert!(account["snapshot"]["balance_cu"].as_f64().unwrap() > balance - 1.0);
            assert!(account["snapshot"]["rate_cu_per_hour"].as_f64().unwrap() > 0.0);
            assert!(account["eta"].as_u64().unwrap() > 0);
            assert_eq!(account["snapshot"]["stale"], false);
            assert!(account["last_error"].is_null());
        }
        snapshot_when(&mut stream, |snapshot| snapshot["usage"] == fresh["usage"]);

        backend.set_failures(MockFailures {
            usage_fetch_fails: true,
            ..Default::default()
        });
        let stale = mutate(&client, REFRESH, &json!({}), StatusCode::OK);
        for (stale, fresh) in stale["usage"]
            .as_array()
            .unwrap()
            .iter()
            .zip(fresh["usage"].as_array().unwrap())
        {
            assert_eq!(stale["snapshot"]["stale"], true);
            assert_eq!(
                stale["snapshot"]["balance_cu"],
                fresh["snapshot"]["balance_cu"]
            );
            assert_eq!(stale["last_error"]["kind"], "http");
        }
        let updated = snapshot_when(&mut stream, |snapshot| snapshot["usage"] == stale["usage"]);
        assert_eq!(updated["account"], active);
        let other = before["accounts"]["accounts"][1]["id"].as_str().unwrap();
        client.get(&format!("{ACCOUNTS}/{other}/switch"));
        let listed = client.get(ACCOUNTS);
        for (index, usage) in stale["usage"].as_array().unwrap().iter().enumerate() {
            assert_eq!(
                updated["accounts"]["accounts"][index]["usage"],
                usage["snapshot"]
            );
            assert_eq!(
                listed["accounts"]["accounts"][index]["usage"],
                usage["snapshot"]
            );
        }
        assert_eq!(
            backend
                .accounts(&CancelToken::new())
                .unwrap()
                .active
                .unwrap()
                .as_str(),
            active["active"]
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn age_marks_a_cached_usage_sample_stale_even_with_no_fetch_failure() {
    let dir = tempfile::tempdir().unwrap();
    let (config, clock) = MockConfig::headless(MockScenario::single());
    fs::write(
        dir.path().join("settings.json"),
        r#"{"defaults":{"usage_poll_idle":3600}}"#,
    )
    .unwrap();
    exercise(dir.path(), config, move |client, backend, _| {
        let mut stream = events(&client);
        let initial = snapshot_when(&mut stream, |snapshot| {
            snapshot["usage"][0]["snapshot"]["stale"] == false
        });
        assert_eq!(initial["usage"][0]["snapshot"]["balance_cu"], 100.0);
        clock.advance(USAGE_STALE_AFTER + Duration::from_secs(1));
        assert!(!backend.usage_poll_due());
        let aged = snapshot_when(&mut stream, |snapshot| {
            snapshot["usage"][0]["snapshot"]["stale"] == true
        });
        assert_eq!(aged["usage"][0]["snapshot"]["balance_cu"], 100.0);
        assert!(aged["usage"][0]["last_error"].is_null());
        assert_eq!(client.get(ACCOUNTS)["usage"], aged["usage"]);
        backend.set_failures(MockFailures {
            usage_fetch_fails: true,
            ..Default::default()
        });
        let adopted = mutate(
            &client,
            "/api/accounts/adopt",
            &account_action(&client),
            StatusCode::OK,
        );
        assert_eq!(adopted["usage"], aged["usage"][0]["snapshot"]);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn adopts_an_unsaved_cli_credential_and_rejects_removing_the_active_account() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::single());
    config.failures.unadopted_slot = true;
    exercise(dir.path(), config, |client, _, _| {
        let before = client.get(ACCOUNTS);
        assert_eq!(before["accounts"]["unadopted"], true);
        assert!(before["account_context"]["active"].is_null());
        let mut stream = events(&client);
        let adopted = mutate(
            &client,
            "/api/accounts/adopt",
            &account_action(&client),
            StatusCode::OK,
        );
        let snapshot = snapshot_when(&mut stream, |snapshot| {
            snapshot["account"]["active"] == adopted["id"]
        });
        assert_eq!(snapshot["accounts"]["unadopted"], false);
        assert_eq!(before["accounts"]["active_email"], adopted["email"]);

        let remove = format!("{ACCOUNTS}/{}", adopted["id"].as_str().unwrap());
        let error = json(
            client.request("DELETE", &remove, &account_action(&client).to_string()),
            StatusCode::CONFLICT,
        );
        assert_eq!(error["error"]["kind"], "active_account");
        let messages = client.get("/api/i18n/en-US");
        assert!(
            messages[error["error"]["message_key"].as_str().unwrap()]
                .as_str()
                .unwrap()
                .contains("Switch to another account")
        );
        assert_eq!(client.get(ACCOUNTS)["accounts"]["active"], adopted["id"]);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn login_failure_cancel_and_success_publish_state_and_release_the_slot() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::single());
    exercise(dir.path(), config, |client, backend, _| {
        let original = client.get(ACCOUNTS)["accounts"]["active"].clone();
        let mut stream = events(&client);
        for (failure, status, kind) in [
            (
                MockLoginFailure::InvalidCode,
                StatusCode::UNPROCESSABLE_ENTITY,
                "login_invalid_code",
            ),
            (
                MockLoginFailure::VerificationFailed,
                StatusCode::BAD_GATEWAY,
                "login_verification_failed",
            ),
        ] {
            backend.set_failures(MockFailures {
                login: Some(failure),
                ..Default::default()
            });
            let login_id = begin_login(&client);
            let pending = snapshot_when(&mut stream, |snapshot| snapshot["login_id"] == login_id);
            assert_eq!(pending["account"]["active"], original);
            assert_eq!(
                client
                    .request("POST", LOGIN, &account_action(&client).to_string())
                    .status(),
                StatusCode::CONFLICT
            );
            let route = format!("{LOGIN}/{login_id}");
            let secret = "mock-one-time-code";
            let error = mutate(&client, &route, &json!({"code": secret}), status);
            assert_eq!(error["error"]["kind"], kind);
            let finished = snapshot_when(&mut stream, |snapshot| {
                snapshot["login_id"].is_null() && snapshot["operations"] == json!([])
            });
            assert_eq!(finished["account"]["active"], original);
            assert_eq!(
                finished["accounts"]["accounts"].as_array().unwrap().len(),
                1
            );
            assert_eq!(
                backend
                    .accounts(&CancelToken::new())
                    .unwrap()
                    .active
                    .unwrap()
                    .as_str(),
                original
            );
            assert!(!error.to_string().contains(secret));
            assert!(!finished.to_string().contains(secret));
        }

        backend.set_failures(MockFailures::default());
        let login_id = begin_login(&client);
        let route = format!("{LOGIN}/{login_id}");
        snapshot_when(&mut stream, |snapshot| snapshot["login_id"] == login_id);
        assert_eq!(
            client.request("DELETE", &route, "{}").status(),
            StatusCode::NO_CONTENT
        );
        let cancelled = snapshot_when(&mut stream, |snapshot| {
            snapshot["login_id"].is_null() && snapshot["operations"] == json!([])
        });
        assert_eq!(cancelled["account"]["active"], original);
        assert_eq!(
            backend
                .accounts(&CancelToken::new())
                .unwrap()
                .active
                .unwrap()
                .as_str(),
            original
        );
        let stale = mutate(
            &client,
            &route,
            &json!({"code": "demo-code"}),
            StatusCode::CONFLICT,
        );
        assert_eq!(stale["error"]["kind"], "login_cancelled");

        backend.set_failures(MockFailures {
            usage_fetch_fails: true,
            ..Default::default()
        });
        let login_id = begin_login(&client);
        let saved = mutate(
            &client,
            &format!("{LOGIN}/{login_id}"),
            &json!({"code":"demo-code"}),
            StatusCode::OK,
        );
        let finished = snapshot_when(&mut stream, |snapshot| {
            snapshot["account"]["active"] == saved["id"] && snapshot["operations"] == json!([])
        });
        assert_ne!(saved["id"], original);
        assert!(finished["login_id"].is_null());
        let new_account = finished["accounts"]["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|account| account["id"] == saved["id"])
            .unwrap();
        let new_usage = finished["usage"]
            .as_array()
            .unwrap()
            .iter()
            .find(|usage| usage["account"] == saved["id"])
            .unwrap();
        assert_eq!(&saved, new_account);
        assert_eq!(saved["usage"], new_usage["snapshot"]);
        assert_eq!(
            finished["accounts"]["accounts"].as_array().unwrap().len(),
            2
        );

        let remove = format!("{ACCOUNTS}/{}", original.as_str().unwrap());
        assert_eq!(
            client
                .request("DELETE", &remove, &account_action(&client).to_string())
                .status(),
            StatusCode::NO_CONTENT
        );
        let removed = snapshot_when(&mut stream, |snapshot| {
            snapshot["accounts"]["accounts"]
                .as_array()
                .is_some_and(|accounts| accounts.len() == 1)
                && snapshot["operations"] == json!([])
        });
        assert_eq!(removed["accounts"]["accounts"][0]["id"], saved["id"]);
        assert_eq!(removed["usage"].as_array().unwrap().len(), 1);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_reaches_login_while_opening_and_while_submitting() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = MockConfig::interactive(Duration::from_millis(400));
    config.scenario = MockScenario::single();
    exercise(dir.path(), config, |client, backend, _| {
        let original = client.get(ACCOUNTS)["accounts"]["active"].clone();
        let mut stream = events(&client);
        std::thread::scope(|scope| {
            let opening = scope.spawn(|| {
                mutate(
                    &client,
                    LOGIN,
                    &account_action(&client),
                    StatusCode::CONFLICT,
                )
            });
            let opening_id = snapshot_when(&mut stream, |snapshot| {
                snapshot["operations"][0]["operation"]["kind"] == "login"
            })["operations"][0]["id"]
                .clone();
            let route = format!("{LOGIN}/{opening_id}");
            assert_eq!(
                client.request("DELETE", &route, "{}").status(),
                StatusCode::ACCEPTED
            );
            assert_eq!(opening.join().unwrap()["error"]["kind"], "cancelled");
        });
        let opened = begin_login(&client);
        let route = format!("{LOGIN}/{opened}");
        std::thread::scope(|scope| {
            let submitting = scope.spawn(|| {
                mutate(
                    &client,
                    &route,
                    &json!({"code":"demo-code"}),
                    StatusCode::CONFLICT,
                )
            });
            snapshot_when(&mut stream, |snapshot| {
                snapshot["operations"][0]["operation"]["login_id"] == opened
            });
            assert_eq!(
                client.request("DELETE", &route, "{}").status(),
                StatusCode::ACCEPTED
            );
            assert_eq!(submitting.join().unwrap()["error"]["kind"], "cancelled");
        });
        let finished = snapshot_when(&mut stream, |snapshot| {
            snapshot["login_id"].is_null()
                && snapshot["operations"] == json!([])
                && snapshot["account"]["active"] == original
        });
        assert_eq!(
            finished["accounts"]["accounts"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            backend
                .accounts(&CancelToken::new())
                .unwrap()
                .active
                .unwrap()
                .as_str(),
            original
        );
        assert_eq!(client.get(ACCOUNTS)["accounts"]["active"], original);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn oauth_inactivity_rolls_back_after_a_browser_disconnect() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::single());
    let store = SettingsStore::new(Some(dir.path().into()));
    exercise_backend(
        dir.path(),
        store.clone(),
        WebSettings::load(store),
        Arc::new(MockBackend::new(config)),
        (None, Some(Duration::from_secs(1))),
        vec![],
        |client, backend, _| {
            let original = client.get(ACCOUNTS)["accounts"]["active"].clone();
            let mut stream = events(&client);
            let login_id = begin_login(&client);
            snapshot_when(&mut stream, |snapshot| snapshot["login_id"] == login_id);
            drop(stream);

            let timed_out = snapshot_when(&mut events(&client), |snapshot| {
                snapshot["login_id"].is_null() && snapshot["operations"] == json!([])
            });
            assert_eq!(timed_out["account"]["active"], original);
            assert_eq!(
                backend
                    .accounts(&CancelToken::new())
                    .unwrap()
                    .active
                    .unwrap()
                    .as_str(),
                original
            );
            let expired = mutate(
                &client,
                &format!("{LOGIN}/{login_id}"),
                &json!({"code":"demo-code"}),
                StatusCode::CONFLICT,
            );
            assert_eq!(expired["error"]["kind"], "login_cancelled");
            let another = begin_login(&client);
            assert_ne!(another, login_id);
            assert_eq!(
                client
                    .request("DELETE", &format!("{LOGIN}/{another}"), "{}")
                    .status(),
                StatusCode::NO_CONTENT
            );
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn switch_requires_current_impact_and_closes_forwards_without_stopping_runtimes() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(dir.path(), config, |client, backend, _| {
        let accounts = client.get(ACCOUNTS);
        let active = &accounts["account_context"]["active"];
        let target = &accounts["accounts"]["accounts"][1]["id"];
        let route = format!("{ACCOUNTS}/{}/switch", target.as_str().unwrap());
        let before = client.get(&route);
        assert_eq!(
            client
                .request("POST", &route, &account_action(&client).to_string())
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let impact = &before["impact"];
        assert_eq!(impact["from"], *active);
        assert_eq!(impact["to"], *target);
        assert_eq!(impact["tunnels_closing"], json!([]));
        assert_eq!(impact["sessions_left_running"].as_array().unwrap().len(), 2);
        assert_eq!(
            impact["unmanaged_left_running"].as_array().unwrap().len(),
            1
        );

        let forward = mutate(
            &client,
            "/api/forwards",
            &json!({
                "account_context": accounts["account_context"],
                "account": active,
                "session": "a100-7f3a",
                "local_port": free_port(),
                "remote_port": free_port(),
            }),
            StatusCode::CREATED,
        );
        let stale = mutate(&client, &route, &before, StatusCode::CONFLICT);
        assert_eq!(stale["error"]["kind"], "switch_impact_changed");

        backend.set_failures(MockFailures {
            unlisted_accounts: vec!["ada@example.com".into()],
            ..Default::default()
        });
        let partial = client.get(&route);
        assert_eq!(partial["impact"]["tunnels_closing"][0]["id"], forward["id"]);
        assert_eq!(
            partial["impact"]["sessions_left_running"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(partial["impact"]["unmanaged_left_running"].is_null());
        assert_eq!(client.get(ACCOUNTS)["account_context"]["active"], *active);

        backend.set_failures(MockFailures::default());
        let preview = client.get(&route);
        assert_eq!(
            preview["impact"]["unmanaged_left_running"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut stream = events(&client);
        let switched = mutate(&client, &route, &preview, StatusCode::OK);
        assert_eq!(switched["active"], *target);
        let settled = snapshot_when(&mut stream, |snapshot| {
            snapshot["account"]["active"] == *target && snapshot["operations"] == json!([])
        });
        assert_eq!(settled["tunnels"], json!([]));
        assert_eq!(settled["runtimes"]["runtimes"].as_array().unwrap().len(), 4);
        assert_eq!(client.get("/api/forwards"), json!([]));
        let stale = mutate(&client, &route, &preview, StatusCode::CONFLICT);
        assert_eq!(stale["error"]["kind"], "account_not_active");
    })
    .await;
}
