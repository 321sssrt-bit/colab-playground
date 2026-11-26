use colab_playground_core::{accounts::AccountId, provision::ProvisionSpec};
use colab_playground_shared::i18n::keys;
use serde_json::json;

use super::{fixture::Fixtures, *};

const SESSIONS: &str = "/api/sessions";
const AUTO_STOP: &str = "/api/sessions/auto-stop";
const STOP: &str = "/api/sessions/stop";
const STOP_ALL: &str = "/api/sessions/stop-all";

fn post(client: &Client, path: &str, body: Value) -> Response<Body> {
    client.request("POST", path, &body.to_string())
}

fn create_body(client: &Client, name: &str) -> Value {
    let mut spec = client.get("/api/sessions/template");
    let _: ProvisionSpec = serde_json::from_value(spec.clone()).unwrap();
    spec["name"] = json!(name);
    json!({"account_context": client.get(SESSIONS)["account_context"], "spec": spec})
}

fn submit(client: &Client, body: &Value) -> u64 {
    json(post(client, SESSIONS, body.clone()), StatusCode::ACCEPTED)["id"]
        .as_u64()
        .unwrap()
}

fn updates(client: &Client, id: u64) -> BufReader<impl Read + use<>> {
    let response = client.request("POST", &format!("{SESSIONS}/{id}/events"), "{}");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    BufReader::new(response.into_body().into_reader())
}

fn finished(reader: &mut impl BufRead) -> (Vec<Value>, Value) {
    let mut progress = Vec::new();
    loop {
        let (event, data) = next_event(reader);
        if event == "finished" {
            return (progress, data);
        }
        assert_eq!(event, "progress");
        progress.push(data);
    }
}

fn guard_decision(client: &Client, name: &str, stopped: bool) {
    let response = client.request("POST", "/api/events", "{}");
    assert_eq!(response.status(), StatusCode::OK);
    let mut reader = BufReader::new(response.into_body().into_reader());
    loop {
        let (event, data) = next_event(&mut reader);
        if event == "snapshot"
            && data["guard"]["decisions"]
                .as_array()
                .is_some_and(|decisions| {
                    decisions.iter().any(|entry| {
                        entry["session"]["name"] == name && entry["stopped"] == stopped
                    })
                })
        {
            return;
        }
    }
}

fn wait_for_allocation(reader: &mut impl BufRead) {
    loop {
        let (name, data) = next_event(reader);
        assert_eq!(name, "progress", "{data}");
        if data["event"] == "allocated" {
            return;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_refresh_the_account_context_after_keyring_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::single());
    config.failures.keyring_unavailable = true;
    exercise(dir.path(), config, |client, backend, _| {
        let error = json(client.request("GET", SESSIONS, ""), StatusCode::CONFLICT);
        assert_eq!(error["error"]["kind"], "keyring_unavailable");
        backend.set_failures(MockFailures::default());

        let listed = client.get(SESSIONS);
        assert_eq!(listed["account_context"]["active"], "mock1");
        assert!(listed["account_context"]["revision"].as_u64().unwrap() > 0);
        assert_eq!(client.get("/api/snapshot")["accounts_error"], Value::Null);

        let spec = client.get("/api/sessions/template");
        let body = json!({"account_context": listed["account_context"], "spec": spec});
        assert_eq!(
            finished(&mut updates(&client, submit(&client, &body))).1["phase"],
            "ready"
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn provisions_with_vram_retry_one_time_guard_and_account_quota() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::single());
    config.step_delay = Duration::ZERO;
    exercise(dir.path(), config, |client, _, _| {
        let defaults = client.get("/api/settings")["defaults"].clone();
        let template = client.get("/api/sessions/template");
        assert!(!template["name"].as_str().unwrap().is_empty());
        assert_eq!(template["guard"]["max_runtime"], defaults["max_runtime"]);

        let mut body = create_body(&client, "fit-a100");
        body["spec"]["accelerator"] = json!("A100");
        body["spec"]["high_mem"] = json!(true);
        body["spec"]["min_vram_mib"] = json!(70_000);
        body["spec"]["guard"] = json!({"max_runtime": 3600, "idle_timeout": 123, "max_spend_cu": 25.0, "min_balance_cu": 1.0});
        let id = submit(&client, &body);
        let (progress, result) = finished(&mut updates(&client, id));
        let phases: Vec<_> = progress.iter().map(|item| item["event"].as_str().unwrap()).collect();
        assert_eq!(phases, [
            "allocating", "allocated", "probed", "rejected", "releasing", "retrying",
            "allocating", "allocated", "probed", "watchdog_started",
        ]);
        assert_eq!(progress[3]["vram_mib"], 40_960);
        assert_eq!(result["phase"], "ready");
        assert_eq!(result["outcome"]["attempts"], 2);
        assert_eq!(result["outcome"]["hardware"]["vram_mib"], 81_920);
        assert_eq!(finished(&mut updates(&client, id)).1, result);
        guard_decision(&client, "fit-a100", false);

        let listed = client.get(SESSIONS);
        let runtimes = listed["runtimes"].as_array().unwrap();
        assert_eq!(runtimes.len(), 1);
        let runtime = &runtimes[0];
        assert_eq!(runtime["high_mem"], true);
        assert_eq!(runtime["tracked"]["policy"], body["spec"]["guard"]);
        assert_eq!(runtime["estimated_rate_cu_per_hour"].as_f64().map(|rate| rate > 0.0), Some(true));
        assert!(runtime["estimated_spend_cu"].is_number());
        assert_eq!(runtime["auto_stop_at"].as_u64().unwrap() - listed["sampled_at"].as_u64().unwrap(), 3600);
        assert_eq!(client.get("/api/settings")["defaults"], defaults);

        let second = create_body(&client, "second");
        assert_eq!(finished(&mut updates(&client, submit(&client, &second))).1["phase"], "ready");
        let third = create_body(&client, "over-quota");
        let (progress, result) = finished(&mut updates(&client, submit(&client, &third)));
        assert!(progress.is_empty());
        assert_eq!(result["phase"], "failed");
        assert_eq!(result["error"]["kind"], "session_limit_reached");
        assert_eq!(client.get(SESSIONS)["runtimes"].as_array().unwrap().len(), 2);

        let mut stale_target = runtime["id"].clone();
        stale_target["name"] = Value::Null;
        assert_eq!(post(&client, STOP, json!({"confirmed": true, "target": stale_target})).status(), StatusCode::NO_CONTENT);
        let updated = json(client.request("PATCH", "/api/settings", r#"{"defaults":{"high_mem":true}}"#), StatusCode::OK);
        assert_eq!(updated["defaults"]["high_mem"], true);
        let mut fixed_shape = create_body(&client, "fixed-memory");
        assert_eq!(fixed_shape["spec"]["high_mem"], true);
        fixed_shape["spec"]["accelerator"] = json!("L4");
        assert_eq!(finished(&mut updates(&client, submit(&client, &fixed_shape))).1["phase"], "ready");
        let listing = client.get(SESSIONS);
        let l4 = listing["runtimes"].as_array().unwrap().iter().find(|r| r["id"]["name"] == "fixed-memory").unwrap();
        assert_eq!(l4["high_mem"], false);
    }).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn guard_stops_only_managed_runtimes_and_manual_stop_reaches_inactive_accounts() {
    let dir = tempfile::tempdir().unwrap();
    let mut scenario = MockScenario::demo();
    scenario
        .runtimes
        .retain(|runtime| !runtime.managed || runtime.account != 0);
    let (config, _) = MockConfig::headless(scenario);
    exercise(dir.path(), config, |client, backend, _| {
        let before = client.get(SESSIONS);
        assert_eq!(before["runtimes"].as_array().unwrap().len(), 2);
        let active = AccountId::new("mock1").unwrap();
        let inactive = AccountId::new("mock2").unwrap();
        let other = backend.add_unmanaged_runtime(&inactive, Accelerator::None);
        let mut body = create_body(&client, "low-balance");
        body["spec"]["guard"] = json!({"min_balance_cu": 1000.0});
        let id = submit(&client, &body);
        assert_eq!(finished(&mut updates(&client, id)).1["phase"], "ready");

        guard_decision(&client, "low-balance", true);
        let listed = client.get(SESSIONS);
        let runtimes = listed["runtimes"].as_array().unwrap();
        assert_eq!(runtimes.len(), 3);
        assert!(
            runtimes
                .iter()
                .any(|r| r["managed"] == false && r["id"]["account"] == active.as_str())
        );
        let external = runtimes
            .iter()
            .find(|r| r["id"]["endpoint"] == other)
            .unwrap();
        assert_eq!(external["managed"], false);
        assert_eq!(external["on_active_account"], false);
        assert_eq!(
            post(
                &client,
                STOP,
                json!({"target": external["id"], "confirmed": false})
            )
            .status(),
            StatusCode::CONFLICT
        );
        for runtime in runtimes
            .iter()
            .filter(|r| r["id"]["account"] == inactive.as_str())
        {
            let request = json!({"target": runtime["id"], "confirmed": true});
            assert_eq!(
                post(&client, STOP, request.clone()).status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(post(&client, STOP, request).status(), StatusCode::NOT_FOUND);
        }
        assert_eq!(
            client.get(SESSIONS)["runtimes"].as_array().unwrap().len(),
            1
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_stop_reports_watchdog_and_app_deadline_after_failed_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, clock) = MockConfig::headless(MockScenario::demo());
    config.step_delay = Duration::ZERO;
    exercise(dir.path(), config, move |client, backend, _| {
        let listed = client.get(SESSIONS);
        let action = |kind: Value, runtime: &Value, status| {
            json(
                post(
                    &client,
                    AUTO_STOP,
                    json!({
                        "account_context": listed["account_context"],
                        "target": runtime["id"], "action": kind
                    }),
                ),
                status,
            )
        };
        let runtimes = listed["runtimes"].as_array().unwrap();
        let runtime = runtimes
            .iter()
            .find(|r| r["id"]["name"] == "a100-7f3a")
            .unwrap();
        let other = runtimes
            .iter()
            .find(|r| r["on_active_account"] == false)
            .unwrap();
        let external = runtimes.iter().find(|r| r["managed"] == false).unwrap();
        assert_eq!(
            action(json!({"kind":"cancel"}), other, StatusCode::CONFLICT)["error"]["kind"],
            "account_not_active"
        );
        assert_eq!(
            action(
                json!({"kind":"cancel"}),
                external,
                StatusCode::UNPROCESSABLE_ENTITY
            )["error"]["kind"],
            "invalid_input"
        );
        let set = action(json!({"kind":"set","seconds":600}), runtime, StatusCode::OK);
        assert_eq!(set["app_limit_seconds"], 600);
        assert_eq!(set["watchdog_armed"], true);
        clock.advance(Duration::from_secs(30));
        let extend = action(
            json!({"kind":"extend","seconds":120}),
            runtime,
            StatusCode::OK,
        );
        assert_eq!(extend["app_limit_seconds"], 690);
        assert_eq!(extend["watchdog_armed"], true);

        let cancel = action(json!({"kind":"cancel"}), runtime, StatusCode::OK);
        assert_eq!(cancel["app_limit_seconds"], Value::Null);
        assert_eq!(cancel["watchdog_armed"], false);
        let lookup = || {
            client.get(SESSIONS)["runtimes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == runtime["id"])
                .unwrap()
                .clone()
        };
        assert_eq!(lookup()["auto_stop_at"], Value::Null);
        backend.set_failures(MockFailures {
            watchdog_restart_fails: true,
            ..Default::default()
        });
        let app = action(json!({"kind":"set","seconds":300}), runtime, StatusCode::OK);
        assert_eq!(app["app_limit_seconds"], 300);
        assert_eq!(app["watchdog_armed"], false);
        assert_eq!(app["watchdog"]["deadline"], Value::Null);
        assert_eq!(app["warning_key"], keys::RUNTIME_AUTO_STOP_APP_ONLY);
        let after = lookup();
        assert_eq!(
            after["auto_stop_at"].as_u64().unwrap()
                - colab_playground_core::clock::unix_secs(backend.now()),
            300
        );
        assert_eq!(after["tracked"]["watchdog"]["armed"], false);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_and_stop_all_release_allocations_and_keep_serving() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = MockConfig::interactive(Duration::from_millis(350));
    config.scenario = MockScenario::single();
    exercise(dir.path(), config, |client, backend, _| {
        let body = create_body(&client, "cancel-me");
        let id = submit(&client, &body);
        let mut reader = updates(&client, id);
        wait_for_allocation(&mut reader);
        assert_eq!(submit(&client, &body), id);
        assert_eq!(
            client
                .request("POST", &format!("{SESSIONS}/{id}/cancel"), "{}")
                .status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(finished(&mut reader).1["phase"], "cancelled");
        assert_eq!(client.get(SESSIONS)["runtimes"], json!([]));

        let active = AccountId::new("mock1").unwrap();
        backend.add_unmanaged_runtime(&active, Accelerator::L4);
        let id = submit(&client, &create_body(&client, "stop-all-me"));
        let mut reader = updates(&client, id);
        wait_for_allocation(&mut reader);
        let listings = backend.runtime_listings();
        let report = json(
            post(&client, STOP_ALL, json!({"confirmed": true})),
            StatusCode::OK,
        );
        assert_eq!(
            report,
            json!({"verified": true, "remaining": [], "account_errors": []})
        );
        assert!(backend.runtime_listings() >= listings + 2);
        assert_eq!(finished(&mut reader).1["phase"], "cancelled");
        assert_eq!(client.get(SESSIONS)["runtimes"], json!([]));
        assert_eq!(client.get("/api/snapshot")["shutting_down"], false);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_all_reports_remaining_runtime_and_unverifiable_account() {
    let dir = tempfile::tempdir().unwrap();
    let mut scenario = MockScenario::demo();
    scenario.runtimes[2].account = 1;
    let (mut config, _) = MockConfig::headless(scenario);
    config.failures.unlisted_accounts = vec!["lin@example.com".into()];
    let backend = Arc::new(Fixtures {
        mock: MockBackend::new(config),
        checkout: dir.path().into(),
        stop_failure: Some("t4-91c2"),
    });
    let store = SettingsStore::new(Some(dir.path().into()));
    let settings = WebSettings::load(store.clone());
    exercise_backend(
        dir.path(),
        store,
        settings,
        backend,
        (None, None),
        vec![],
        |client, backend, _| {
            let listed = client.get(SESSIONS);
            let target = listed["runtimes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"]["name"] == "t4-91c2")
                .unwrap();
            let error = json(
                post(
                    &client,
                    STOP,
                    json!({"target": target["id"], "confirmed": true}),
                ),
                StatusCode::BAD_GATEWAY,
            );
            assert_eq!(error["error"]["kind"], "http");
            let report = json(
                post(&client, STOP_ALL, json!({"confirmed": true})),
                StatusCode::OK,
            );
            assert_eq!(report["verified"], false);
            let remaining = report["remaining"].as_array().unwrap();
            assert_eq!(remaining.len(), 1);
            assert_eq!(remaining[0]["target"]["name"], "t4-91c2");
            assert_eq!(remaining[0]["error"]["kind"], "http");
            assert_eq!(report["account_errors"].as_array().unwrap().len(), 1);
            assert_eq!(report["account_errors"][0]["account"], "mock2");
            assert_eq!(report["account_errors"][0]["error"]["kind"], "http");
            backend.mock.set_failures(MockFailures {
                runtimes_listing_fails: true,
                ..Default::default()
            });
            assert_eq!(
                post(&client, STOP_ALL, json!({"confirmed": true})).status(),
                StatusCode::BAD_GATEWAY
            );
            assert_eq!(client.get("/api/snapshot")["shutting_down"], false);
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn single_stop_and_auto_stop_do_not_trigger_redundant_runtime_listings() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::demo());
    config.step_delay = Duration::ZERO;
    exercise(dir.path(), config, |client, backend, _| {
        let listed = client.get(SESSIONS);
        let runtime = listed["runtimes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"]["name"] == "a100-7f3a")
            .unwrap()
            .clone();

        for action in [
            json!({"kind": "set", "seconds": 600}),
            json!({"kind": "extend", "seconds": 120}),
            json!({"kind": "cancel"}),
        ] {
            let before = backend.runtime_listings();
            let _ = json(
                post(
                    &client,
                    AUTO_STOP,
                    json!({
                        "account_context": listed["account_context"],
                        "target": runtime["id"],
                        "action": action,
                    }),
                ),
                StatusCode::OK,
            );
            // Allow any accidental background refresh to fire if one had been scheduled.
            std::thread::sleep(Duration::from_millis(50));
            assert_eq!(backend.runtime_listings(), before + 1);
        }

        let before = backend.runtime_listings();
        assert_eq!(
            post(
                &client,
                STOP,
                json!({"target": runtime["id"], "confirmed": true})
            )
            .status(),
            StatusCode::NO_CONTENT
        );
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(backend.runtime_listings(), before + 1);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn measured_rates_survive_stopping_and_guard_ack_consumes_retained_decisions() {
    let dir = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::single());
    config.step_delay = Duration::ZERO;
    exercise(dir.path(), config, |client, _, _| {
        let mut body = create_body(&client, "rate-t4");
        body["spec"]["accelerator"] = json!("T4");
        body["spec"]["min_vram_mib"] = Value::Null;
        body["spec"]["guard"] = json!({"max_runtime": 3600});
        let id = submit(&client, &body);
        assert_eq!(finished(&mut updates(&client, id)).1["phase"], "ready");
        guard_decision(&client, "rate-t4", false);

        let listed = client.get(SESSIONS);
        let runtime = listed["runtimes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"]["name"] == "rate-t4")
            .unwrap()
            .clone();
        assert_eq!(
            post(
                &client,
                STOP,
                json!({"target": runtime["id"], "confirmed": true})
            )
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(client.get(SESSIONS)["runtimes"], json!([]));

        let template = client.get("/api/sessions/template");
        let _: ProvisionSpec = serde_json::from_value(template.clone()).unwrap();
        let rates = template["measured_rates"].as_array().unwrap();
        assert_eq!(rates.len(), 1);
        assert_eq!(rates[0]["accelerator"], "T4");
        assert!(rates[0]["reading"]["cu_per_hour"].as_f64().unwrap() > 0.0);
        assert!(template["sampled_at"].is_u64());

        let overview = client.get("/api/overview");
        assert_eq!(overview["measured_rates"], template["measured_rates"]);
        assert!(overview["sampled_at"].is_u64());

        let snapshot = client.get("/api/snapshot");
        assert_eq!(snapshot["measured_rates"], template["measured_rates"]);
        assert!(snapshot["server_now"].is_u64());

        // Trigger a guard stop, confirm it survives a follow-up GET /api/sessions, then ack it.
        let mut low = create_body(&client, "guard-stopped");
        low["spec"]["accelerator"] = json!("NONE");
        low["spec"]["min_vram_mib"] = Value::Null;
        low["spec"]["guard"] = json!({"min_balance_cu": 1000.0});
        let id = submit(&client, &low);
        assert_eq!(finished(&mut updates(&client, id)).1["phase"], "ready");
        guard_decision(&client, "guard-stopped", true);

        let after_refresh = client.get(SESSIONS);
        let events = after_refresh["guard_events"].as_array().unwrap();
        let stopped_event = events
            .iter()
            .find(|e| e["kind"] == "stopped" && e["session"]["name"] == "guard-stopped")
            .expect("guard stopped event must survive subsequent refresh");
        let event_id = stopped_event["id"].as_u64().unwrap();
        assert!(
            after_refresh["guard"]["decisions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["session"]["name"] == "guard-stopped" && d["stopped"] == true)
        );
        assert!(
            after_refresh["ended"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["runtime"]["name"] == "guard-stopped" && e["reason"]["kind"] == "guard")
        );

        assert_eq!(
            post(
                &client,
                "/api/sessions/guard/ack",
                json!({"up_to_id": event_id})
            )
            .status(),
            StatusCode::NO_CONTENT
        );
        let after_ack = client.get(SESSIONS);
        assert!(
            !after_ack["guard_events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == event_id)
        );
        assert!(
            after_ack["ended"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["runtime"]["name"] == "guard-stopped" && e["reason"]["kind"] == "guard")
        );
    })
    .await;
}
