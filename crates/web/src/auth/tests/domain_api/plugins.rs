mod fixture;

use colab_playground_core::{
    CancelToken,
    backend::RunTarget,
    quant::{FitInput, fit_auto, fit_fixed},
};
use serde_json::json;

use self::fixture::Fixtures;
use super::*;

const PLUGINS: &str = "/api/plugins";
const PREVIEWS: &str = "/api/plugins/previews";
const RUNS: &str = "/api/plugins/runs";
const TOKEN: &str = "/api/plugins/hf/token";
const GGUF: &str = "/api/plugins/hf/gguf";
const REPO: &str = "unsloth/Qwen3-8B-GGUF";
const GIT: &str = "https://fixtures.example.test/plugin.git";
const LOCAL_ID: &str = "test-api";
const NAMED_SESSION: &str = "a100-7f3a";

fn write_plugin(dir: &Path, id: &str, port: u16, script: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("worker.py"),
        "raise AssertionError('must not execute locally')",
    )
    .unwrap();
    fs::write(
        dir.join("plugin.toml"),
        format!(
            r#"
api = 1
id = "{id}"
version = "1.0"
needs = ["hf_token"]
[name]
en = "Test API"
[[inputs]]
id = "credential"
type = "secret"
required = true
[run]
script = "{script}"
[[stages]]
id = "download"
[[stages]]
id = "load"
[[endpoints]]
id = "api"
port = {port}
path = "/v1"
health = "/health"
kind = "openai"
"#
        ),
    )
    .unwrap();
}

fn preview(client: &Client, origin: Value, status: StatusCode) -> Value {
    json(
        client.request("POST", PREVIEWS, &origin.to_string()),
        status,
    )
}

fn install(client: &Client, preview: &Value) -> Value {
    let id = preview["preview_id"].as_str().unwrap();
    json(
        client.request("POST", &format!("{PREVIEWS}/{id}"), "{}"),
        StatusCode::CREATED,
    )
}

fn existing(client: &Client) -> Value {
    let snapshot = client.get("/api/snapshot");
    let runtime = snapshot["runtimes"]["runtimes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|runtime| runtime["id"]["name"] == NAMED_SESSION)
        .unwrap();
    runtime["id"].clone()
}

fn submit(client: &Client, spec: Value, target: Option<Value>) -> Response<Body> {
    client.request(
        "POST",
        RUNS,
        &json!({
            "account_context": client.get("/api/snapshot")["account"],
            "spec": spec,
            "existing": target,
        })
        .to_string(),
    )
}

fn start(client: &Client, spec: Value, target: Option<Value>) -> u64 {
    json(submit(client, spec, target), StatusCode::ACCEPTED)["id"]
        .as_u64()
        .unwrap()
}

fn run_events(client: &Client, id: u64, remote: bool) -> BufReader<impl Read + use<>> {
    let path = format!("{RUNS}/{id}/events");
    let response = if remote {
        client
            .agent
            .run(
                Request::builder()
                    .method("POST")
                    .uri(format!("{}{path}", client.origin))
                    .header("host", "remote.example.test")
                    .header("origin", "https://remote.example.test")
                    .header("authorization", format!("Bearer {}", client.token))
                    .header("content-type", "application/json")
                    .body("{}")
                    .unwrap(),
            )
            .unwrap()
    } else {
        client.request("POST", &path, "{}")
    };
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    BufReader::new(response.into_body().into_reader())
}

fn until(reader: &mut impl BufRead, expect: &str) -> Value {
    loop {
        let (name, data) = next_event(reader);
        if name == expect {
            return data;
        }
        assert_ne!(name, "finished", "run finished before {expect}: {data}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn folder_install_previews_permissions_and_checks_paths_and_manifest() {
    let data = tempfile::tempdir().unwrap();
    let inputs = tempfile::tempdir().unwrap();
    let port = free_port();
    let good = inputs.path().join("good");
    write_plugin(&good, LOCAL_ID, port, "worker.py");
    let reserved = inputs.path().join("reserved");
    write_plugin(&reserved, "llama-cpp", port, "worker.py");
    let invalid = inputs.path().join("invalid");
    write_plugin(&invalid, "bad", port, "../worker.py");
    let (config, _) = MockConfig::headless(MockScenario::single());
    exercise(data.path(), config, move |client, _, _| {
        let p = preview(
            &client,
            json!({"kind":"folder", "path":good}),
            StatusCode::CREATED,
        );
        assert_eq!(p["manifest"]["id"], LOCAL_ID);
        assert_eq!(p["manifest"]["needs"], json!(["hf_token"]));
        assert_eq!(p["manifest"]["inputs"][0]["type"], "secret");
        assert_eq!(p["warning_key"], "app.b2.plugin_runs_on_runtime");
        assert!(p["script_bytes"].as_u64().unwrap() > 0);
        assert!(p.get("staged_dir").is_none());
        assert_eq!(client.get(PLUGINS).as_array().unwrap().len(), 1);
        let installed = install(&client, &p);
        assert_eq!(installed["source"]["kind"], "user");
        assert_eq!(installed["enabled"], true);
        assert_eq!(client.get(PLUGINS).as_array().unwrap().len(), 2);
        let id = p["preview_id"].as_str().unwrap();
        assert_eq!(
            client
                .request("POST", &format!("{PREVIEWS}/{id}"), "{}")
                .status(),
            StatusCode::NOT_FOUND
        );

        let target = format!("{PLUGINS}/{LOCAL_ID}");
        assert_eq!(
            client
                .request("PATCH", &target, r#"{"enabled":false}"#)
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(client.get(PLUGINS)[1]["enabled"], false);
        assert_eq!(
            client
                .request("PATCH", &target, r#"{"enabled":true}"#)
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(client.get(PLUGINS)[1]["enabled"], true);
        let discarded = preview(
            &client,
            json!({"kind":"folder", "path":good}),
            StatusCode::CREATED,
        );
        assert_eq!(discarded["replaces_version"], "1.0");
        let id = discarded["preview_id"].as_str().unwrap();
        assert_eq!(
            client
                .request("DELETE", &format!("{PREVIEWS}/{id}"), "{}")
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            client
                .request("POST", &format!("{PREVIEWS}/{id}"), "{}")
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client.request("DELETE", &target, "{}").status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(client.get(PLUGINS).as_array().unwrap().len(), 1);
        assert_eq!(
            client
                .request("DELETE", "/api/plugins/llama-cpp", "{}")
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let overlap = preview(
            &client,
            json!({"kind":"folder","path":reserved}),
            StatusCode::CONFLICT,
        );
        assert_eq!(overlap["error"]["kind"], "plugin_exists");
        preview(
            &client,
            json!({"kind":"folder","path":invalid}),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
        preview(
            &client,
            json!({"kind":"folder","path":good.join("../good")}),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
        let git = preview(
            &client,
            json!({"kind":"git","url":GIT}),
            StatusCode::BAD_GATEWAY,
        );
        assert_eq!(git["error"]["kind"], "git_failed");
        preview(
            &client,
            json!({"kind":"git","url":"file:///tmp/plugin"}),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hf_token_is_presence_only_and_gguf_fit_matches_core() {
    let data = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::single());
    exercise(data.path(), config, |client, backend, _| {
        assert_eq!(client.get(TOKEN), json!({"saved":false}));
        let saved = json(
            client.request("PUT", TOKEN, r#"{"token":" hf_fixture_no_echo "}"#),
            StatusCode::OK,
        );
        assert_eq!(saved, json!({"saved":true}));
        assert_eq!(client.get(TOKEN), saved);
        assert!(
            !client
                .get("/api/snapshot")
                .to_string()
                .contains("hf_fixture_no_echo")
        );
        let cleared = json(client.request("DELETE", TOKEN, "{}"), StatusCode::OK);
        assert_eq!(cleared, json!({"saved":false}));
        let models = json(
            client.request("POST", "/api/plugins/hf/search", r#"{"query":" Qwen3 "}"#),
            StatusCode::OK,
        );
        assert_eq!(models.as_array().unwrap().len(), 2);
        assert_eq!(models[1]["id"], REPO);

        let fit = FitInput {
            vram_mib: 16_384,
            ctx: 8192,
            model_ctx: None,
            kv_bytes_per_token: None,
            mmproj_bytes: 0,
            kv: None,
        };
        let listing = backend.hf_files(REPO, &CancelToken::new()).unwrap();
        let auto = json(
            client.request("POST", GGUF, &json!({"repo":REPO, "fit":fit}).to_string()),
            StatusCode::OK,
        );
        assert_eq!(auto["listing"], json!(listing));
        let expected = fit_auto(&listing, &fit).unwrap();
        assert_eq!(auto["fits"][0]["fit"], json!(expected));
        let fixed = json(
            client.request(
                "POST",
                GGUF,
                &json!({"repo":REPO, "fit":fit, "quant":"Q4_K_M"}).to_string(),
            ),
            StatusCode::OK,
        );
        assert_eq!(
            fixed["fits"][0]["fit"],
            json!(fit_fixed(&listing, "Q4_K_M", &fit).unwrap())
        );
        let no_fit = json(
            client.request(
                "POST",
                GGUF,
                &json!({
                    "repo":REPO,
                    "fit":FitInput { vram_mib: 1, ..fit },
                    "quant":"Q4_K_M",
                })
                .to_string(),
            ),
            StatusCode::OK,
        );
        assert_eq!(no_fit["fits"][0]["fit"], Value::Null);
        assert_eq!(no_fit["listing"], json!(listing));
        assert_eq!(no_fit["fits"][0]["fit_error"]["kind"], "invalid_input");
        let a100 = json(
            client.request(
                "POST",
                GGUF,
                &json!({"repo":REPO, "accelerator":"A100"}).to_string(),
            ),
            StatusCode::OK,
        );
        let fits = a100["fits"].as_array().unwrap();
        assert_eq!(fits.len(), 2);
        for (item, vram_mib) in fits.iter().zip([40_960, 81_920]) {
            assert_eq!(item["vram_mib"], vram_mib);
            let desktop = fit_auto(
                &listing,
                &FitInput {
                    vram_mib,
                    ctx: 0,
                    ..fit.clone()
                },
            )
            .unwrap();
            assert_eq!(item["fit"], json!(desktop));
        }
        let cpu = json(
            client.request(
                "POST",
                GGUF,
                &json!({"repo":REPO, "accelerator":"NONE"}).to_string(),
            ),
            StatusCode::OK,
        );
        assert_eq!(cpu["fits"], json!([]));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn git_fixture_runs_on_existing_session_with_redacted_replay_and_loopback_forward() {
    let data = tempfile::tempdir().unwrap();
    let checkout = tempfile::tempdir().unwrap();
    let port = free_port();
    write_plugin(checkout.path(), LOCAL_ID, port, "worker.py");
    let config = MockConfig::interactive(Duration::from_millis(250));
    let backend = Arc::new(Fixtures {
        mock: MockBackend::new(config),
        checkout: checkout.path().into(),
    });
    let store = SettingsStore::new(Some(data.path().into()));
    let settings = WebSettings::load(store.clone());
    exercise_backend(
        data.path(),
        store,
        settings,
        backend,
        (None, None),
        vec![TrustedHost::parse("https://remote.example.test").unwrap()],
        move |client, _, _| {
            let p = preview(
                &client,
                json!({"kind":"git", "url":GIT}),
                StatusCode::CREATED,
            );
            let installed = install(&client, &p);
            assert_eq!(installed["manifest"]["id"], LOCAL_ID);
            let mut spec = client.get(&format!("{PLUGINS}/{LOCAL_ID}/template"));
            let target = existing(&client);
            spec["target"] = json!({"kind":"existing", "name":target["name"]});
            // The core redactor skips values shorter than four bytes.
            let secret = "~!?";
            spec["inputs"]["credential"] = secret.into();
            let id = start(&client, spec.clone(), Some(target.clone()));
            assert_eq!(id, start(&client, spec, Some(target)));
            let mut stream = run_events(&client, id, false);
            let launched = event(&mut stream, "launched");
            assert_eq!(launched["session"], NAMED_SESSION);
            let running = event(&mut stream, "status");
            assert_eq!(running["stage"], "download");
            assert!(running["progress"].as_f64().unwrap() < 1.0);
            assert_eq!(
                client
                    .request("PATCH", "/api/plugins/llama-cpp", r#"{"enabled":false}"#)
                    .status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(
                client
                    .request(
                        "PATCH",
                        &format!("{PLUGINS}/{LOCAL_ID}"),
                        r#"{"enabled":false}"#
                    )
                    .status(),
                StatusCode::CONFLICT
            );

            let mut global = BufReader::new(
                client
                    .request("POST", "/api/events", "{}")
                    .into_body()
                    .into_reader(),
            );
            let snapshot = next_event(&mut global).1;
            assert!(!snapshot.to_string().contains(secret));
            assert!(!client.get("/api/snapshot").to_string().contains(secret));
            drop(global);
            drop(stream);

            let mut remote = run_events(&client, id, true);
            let skipped = until(&mut remote, "log_skipped");
            assert_eq!(skipped["path"], "/vm/***/run.log");
            assert_eq!(skipped["message_key"], "app.b2.run_log_skipped");
            assert_eq!(
                event(&mut remote, "log")["lines"],
                json!(["credential=***"])
            );
            let status = event(&mut remote, "status");
            assert_eq!(status["message"], "credential=***");
            assert_eq!(status["outputs"]["nested"], json!({"key-***":"***"}));
            let finished = event(&mut remote, "finished");
            assert!(!finished.to_string().contains(secret));
            assert_eq!(finished["phase"], "ready");
            assert_eq!(finished["outcome"]["status"]["progress"], 1.0);
            let forward = &finished["endpoints"][0]["forward"];
            assert_eq!(forward["spec"]["bind"], "loopback");
            assert_eq!(forward["spec"]["local_port"], port);
            assert_eq!(forward["healthy"], true);
            assert_eq!(forward["addresses"]["open_url"], Value::Null);
            assert_eq!(
                forward["addresses"]["notice_key"],
                "web.forward.server_local"
            );

            let mut replay = run_events(&client, id, false);
            let finished = until(&mut replay, "finished");
            assert_eq!(
                finished["endpoints"][0]["forward"]["addresses"]["openai_base_url"],
                format!("http://127.0.0.1:{port}/v1")
            );
            let run = &client.get(RUNS)[0];
            assert_eq!(run["id"], id);
            assert_eq!(run["finished"], true);
            assert_eq!(run["plugin"], LOCAL_ID);
            assert_eq!(run["session"], NAMED_SESSION);
            assert_eq!(run["provisions"], false);
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mock_run_validates_before_launch_and_opens_a_ready_endpoint() {
    let data = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise(data.path(), config, |client, backend, _| {
        let route = "/api/plugins/llama-cpp";
        let target = existing(&client);
        let mut spec = client.get(&format!("{route}/template"));
        spec["target"] = json!({"kind":"existing", "name":target["name"]});
        let mut unknown = spec.clone();
        unknown["plugin"] = "unknown-plugin".into();
        assert_eq!(
            submit(&client, unknown, Some(target.clone())).status(),
            StatusCode::NOT_FOUND
        );
        spec["inputs"]["repo"] = "".into();
        assert_eq!(
            submit(&client, spec.clone(), Some(target.clone())).status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        spec["inputs"]["repo"] = REPO.into();
        spec["inputs"]["port"] = 8080.into();
        let reserved = json(
            submit(&client, spec.clone(), Some(target.clone())),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
        assert_eq!(reserved["error"]["kind"], "port_reserved");
        assert_eq!(reserved["error"]["args"]["port"], "8080");

        let port = free_port();
        spec["inputs"]["port"] = port.into();
        assert_eq!(
            client
                .request("PATCH", route, r#"{"enabled":false}"#)
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            submit(&client, spec.clone(), Some(target.clone())).status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(client.get(RUNS), json!([]));
        assert_eq!(
            client
                .request("PATCH", route, r#"{"enabled":true}"#)
                .status(),
            StatusCode::NO_CONTENT
        );

        let id = start(&client, spec.clone(), Some(target.clone()));
        let mut stream = run_events(&client, id, false);
        let status = until(&mut stream, "status");
        assert_eq!(status["state"], "running");
        assert!(status["progress"].as_f64().unwrap() < 1.0);
        assert!(
            until(&mut stream, "log")["lines"][0]
                .as_str()
                .unwrap()
                .starts_with("[mock]")
        );
        let ready = until(&mut stream, "finished");
        assert_eq!(ready["phase"], "ready");
        assert_eq!(ready["run"]["account"], target["account"]);
        assert_eq!(ready["outcome"]["status"]["progress"], 1.0);
        assert_eq!(ready["endpoints"][0]["forward"]["spec"]["bind"], "loopback");
        assert_eq!(
            ready["endpoints"][0]["forward"]["addresses"]["openai_base_url"],
            format!("http://127.0.0.1:{port}/v1")
        );
        assert_eq!(backend.tunnels().len(), 1);

        let id = start(&client, spec, Some(target));
        let collision = until(&mut run_events(&client, id, false), "finished");
        assert_eq!(collision["phase"], "ready");
        assert_eq!(collision["endpoints"][0]["forward"], Value::Null);
        assert_eq!(collision["endpoints"][0]["error"]["kind"], "port_in_use");
        assert_eq!(
            collision["endpoints"][0]["error"]["args"]["port"],
            port.to_string()
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn provisioned_run_emits_progress_and_cancel_stops_its_session() {
    let data = tempfile::tempdir().unwrap();
    let config = MockConfig {
        scenario: MockScenario::single(),
        ..MockConfig::interactive(Duration::from_millis(300))
    };
    exercise(data.path(), config, |client, backend, _| {
        let mut spec = client.get("/api/plugins/llama-cpp/template");
        let target: RunTarget = serde_json::from_value(spec["target"].clone()).unwrap();
        let RunTarget::Provision(target) = target else {
            panic!("expected provision target")
        };
        spec["inputs"]["repo"] = REPO.into();
        spec["inputs"]["port"] = free_port().into();
        spec["stop_on_failure"] = false.into();
        let id = start(&client, spec, None);
        let mut stream = run_events(&client, id, false);
        let allocated = loop {
            let event = until(&mut stream, "provision");
            if event["event"] == "allocated" {
                break event;
            }
        };
        assert_eq!(allocated["attempt"], 1);
        let launched = until(&mut stream, "launched");
        assert_eq!(launched["session"], target.name);
        assert_eq!(
            client
                .request("POST", &format!("{RUNS}/{id}/cancel"), "{}")
                .status(),
            StatusCode::ACCEPTED
        );
        let finished = until(&mut stream, "finished");
        assert_eq!(finished["phase"], "cancelled");
        assert_eq!(finished["run"]["session"], target.name);
        assert_eq!(finished["run"]["provisions"], true);
        assert!(
            backend
                .runtimes(&CancelToken::new())
                .unwrap()
                .runtimes
                .is_empty()
        );
        assert!(backend.tunnels().is_empty());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_fresh_run_respects_stop_on_failure() {
    let data = tempfile::tempdir().unwrap();
    let (mut config, _) = MockConfig::headless(MockScenario::single());
    config.failures.plugin_fail_stage = Some("download".into());
    exercise(data.path(), config, |client, backend, _| {
        for stop_on_failure in [true, false] {
            let mut spec = client.get("/api/plugins/llama-cpp/template");
            let name = format!("failure-{stop_on_failure}");
            spec["target"]["name"] = name.clone().into();
            spec["inputs"]["repo"] = REPO.into();
            spec["stop_on_failure"] = stop_on_failure.into();
            let id = start(&client, spec, None);
            let finished = until(&mut run_events(&client, id, false), "finished");
            assert_eq!(finished["phase"], "failed");
            assert_eq!(finished["error"]["kind"], "plugin_run_failed");
            let runtimes = backend.runtimes(&CancelToken::new()).unwrap().runtimes;
            assert_eq!(
                runtimes
                    .iter()
                    .any(|runtime| runtime.id.name.as_deref() == Some(&name)),
                !stop_on_failure
            );
        }
    })
    .await;
}
