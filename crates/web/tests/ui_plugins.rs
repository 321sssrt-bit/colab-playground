use std::{
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

use colab_playground_web::assets::{INDEX, lookup};
use sha2::{Digest as _, Sha256};
use ureq::{
    Agent,
    http::{Request, StatusCode},
};

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

fn client() -> Agent {
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
    body: Option<&serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
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
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text))
    };
    (status, parsed)
}

fn login(agent: &Agent, origin: &str, key: &str) -> String {
    let (status, cred) = json_req(
        agent,
        origin,
        "POST",
        "/api/login",
        None,
        Some(&serde_json::json!({ "access_key": key })),
    );
    assert_eq!(status, StatusCode::OK);
    format!("Bearer {}", cred["token"].as_str().unwrap())
}

#[test]
fn plugins_ui_assets_mount_dialog_wire_route_and_cover_all_form_and_endpoint_contracts() {
    assert!(
        INDEX
            .body
            .contains("<dialog id=\"plugin-dialog\" class=\"modal-dialog\"></dialog>"),
        "index.html must mount top-level plugin <dialog> outside #app"
    );

    let main_js = lookup("js/main.js").expect("main.js").body;
    assert!(
        main_js.contains("createPluginsPage"),
        "main.js must wire plugins route to createPluginsPage"
    );
    assert!(
        main_js.contains("initPluginDialogs"),
        "main.js must initialize plugin dialogs"
    );

    let plugins_js = lookup("js/pages/plugins.js")
        .expect("pages/plugins.js")
        .body;
    for marker in [
        "hf-model",
        "\"secret\"",
        "\"select\"",
        "\"bool\"",
        "\"number\"",
        "app.b2.run_secret_note",
        "app.b2.quant_files",
        "app.b3.quant_fits_assumed",
        "app.b2.quant_fits",
        "app.b2.endpoint_healthy",
        "app.b2.endpoint_unhealthy",
        "app.b2.endpoint_not_forwarded",
        "app.b2.endpoint_curl",
        "web.forward.server_local",
        "web.plugins.endpoint_local_curl",
        "web.plugins.history_skipped",
        "app.b2.run_session_stopped",
        "app.b2.run_session_billing",
        "copyTextToClipboard",
        "buildProvisionOptionRows",
        "renderProvisionProgress",
    ] {
        assert!(
            plugins_js.contains(marker),
            "pages/plugins.js missing expected marker {marker}"
        );
    }

    let dialogs_js = lookup("js/plugin-dialogs.js")
        .expect("plugin-dialogs.js")
        .body;
    for marker in [
        "app.b2.plugin_runs_on_runtime",
        "app.b2.plugin_install_title",
        "app.b2.plugin_remove_title",
        "app.b2.hf_token_title",
        "app.b2.hf_token_stored",
        "app.b2.hf_token_none",
        "type: \"password\"",
        "discardPluginPreview",
    ] {
        assert!(
            dialogs_js.contains(marker),
            "plugin-dialogs.js missing expected marker {marker}"
        );
    }

    let store_js = lookup("js/store.js").expect("store.js").body;
    for marker in [
        "/api/plugins/previews",
        "/api/plugins/hf/token",
        "/api/plugins/hf/search",
        "/api/plugins/hf/gguf",
        "/api/plugins/runs",
        "log_skipped",
        "app.b2.run_log_skipped",
    ] {
        assert!(
            store_js.contains(marker),
            "store.js missing expected plugin API/stream marker {marker}"
        );
    }
}

#[test]
fn plugins_management_hf_preview_and_run_stream_contracts_work_in_mock_mode() {
    let dir = tempfile::tempdir().unwrap();
    let key = "test-plugins-ui-key";
    let (_server, origin) = spawn_mock_server(dir.path(), key);
    let agent = client();
    let auth = login(&agent, &origin, key);

    // 1. Bundled llama-cpp plugin is listed and can be toggled disabled/enabled.
    let (status, plugins) = json_req(&agent, &origin, "GET", "/api/plugins", Some(&auth), None);
    assert_eq!(status, StatusCode::OK);
    let list = plugins.as_array().unwrap();
    assert!(list.iter().any(|p| p["manifest"]["id"] == "llama-cpp"));

    let (status, _) = json_req(
        &agent,
        &origin,
        "PATCH",
        "/api/plugins/llama-cpp",
        Some(&auth),
        Some(&serde_json::json!({ "enabled": false })),
    );
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = json_req(
        &agent,
        &origin,
        "PATCH",
        "/api/plugins/llama-cpp",
        Some(&auth),
        Some(&serde_json::json!({ "enabled": true })),
    );
    assert_eq!(status, StatusCode::NO_CONTENT);

    // 2. Folder install preview -> confirm -> remove succeeds; Git URL returns git_failed in mock mode.
    let plugin_dir = dir.path().join("custom-demo");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(
        plugin_dir.join("plugin.toml"),
        r#"
api = 1
id = "custom-demo"
version = "0.2.0"

[name]
en = "Custom demo"

[run]
script = "run.sh"

[[inputs]]
id = "flag"
type = "bool"
default = true
[inputs.label]
en = "Enable flag"
"#,
    )
    .unwrap();
    std::fs::write(plugin_dir.join("run.sh"), "#!/usr/bin/env bash\necho ok\n").unwrap();

    let (status, preview) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/previews",
        Some(&auth),
        Some(&serde_json::json!({
            "kind": "folder",
            "path": plugin_dir.to_string_lossy(),
        })),
    );
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(preview["warning_key"], "app.b2.plugin_runs_on_runtime");
    let preview_id = preview["preview_id"].as_str().unwrap();

    let (status, installed) = json_req(
        &agent,
        &origin,
        "POST",
        &format!("/api/plugins/previews/{preview_id}"),
        Some(&auth),
        Some(&serde_json::json!({})),
    );
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(installed["manifest"]["id"], "custom-demo");

    let (status, _) = json_req(
        &agent,
        &origin,
        "DELETE",
        "/api/plugins/custom-demo",
        Some(&auth),
        Some(&serde_json::json!({})),
    );
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, git_err) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/previews",
        Some(&auth),
        Some(&serde_json::json!({
            "kind": "git",
            "url": "https://github.com/example/plugin.git",
        })),
    );
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(git_err["error"]["kind"], "git_failed");

    // 3. HF Token status / save / delete never echoes the token back.
    let (status, tok) = json_req(
        &agent,
        &origin,
        "GET",
        "/api/plugins/hf/token",
        Some(&auth),
        None,
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tok["saved"], false);

    let (status, tok) = json_req(
        &agent,
        &origin,
        "PUT",
        "/api/plugins/hf/token",
        Some(&auth),
        Some(&serde_json::json!({ "token": "hf_secret_demo_value" })),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tok["saved"], true);
    assert!(!tok.to_string().contains("hf_secret_demo_value"));

    let (status, tok) = json_req(
        &agent,
        &origin,
        "DELETE",
        "/api/plugins/hf/token",
        Some(&auth),
        Some(&serde_json::json!({})),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tok["saved"], false);

    // 4. HF search and GGUF quantisation fit preview return variants and fits.
    let (status, search) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/hf/search",
        Some(&auth),
        Some(&serde_json::json!({ "query": "qwen3" })),
    );
    assert_eq!(status, StatusCode::OK);
    let results = search.as_array().unwrap();
    assert!(!results.is_empty());
    let repo = results[0]["id"].as_str().unwrap().to_owned();

    let (status, gguf) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/hf/gguf",
        Some(&auth),
        Some(&serde_json::json!({
            "repo": repo,
            "accelerator": "A100",
            "fit": { "vram_mib": null, "ctx": 0 },
            "quant": "auto",
        })),
    );
    assert_eq!(status, StatusCode::OK);
    assert!(!gguf["listing"]["variants"].as_array().unwrap().is_empty());
    assert!(!gguf["fits"].as_array().unwrap().is_empty());

    // 5. Running llama-cpp on an existing managed session streams progress, redacts secrets,
    //    and yields ready endpoint addresses.
    let (status, sessions) = json_req(&agent, &origin, "GET", "/api/sessions", Some(&auth), None);
    assert_eq!(status, StatusCode::OK);
    let account_context = sessions["account_context"].clone();
    let managed = sessions["runtimes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["managed"] == true && r["on_active_account"] == true)
        .unwrap()
        .clone();
    let session_name = managed["id"]["name"].as_str().unwrap().to_owned();

    let secret_api_key = "super-secret-api-key-15";
    let (status, accepted) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/plugins/runs",
        Some(&auth),
        Some(&serde_json::json!({
            "account_context": account_context,
            "spec": {
                "plugin": "llama-cpp",
                "inputs": {
                    "repo": repo,
                    "quant": "auto",
                    "ctx": 0,
                    "port": 8000,
                    "api_key": secret_api_key,
                },
                "target": { "kind": "existing", "name": session_name },
                "stop_on_failure": true,
            },
            "existing": managed["id"],
        })),
    );
    assert_eq!(status, StatusCode::ACCEPTED);
    let run_id = accepted["id"].as_u64().unwrap();

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
    assert!(stream_text.contains("event: launched"));
    assert!(stream_text.contains("event: status"));
    assert!(stream_text.contains("event: log"));
    assert!(stream_text.contains("event: finished"));
    assert!(stream_text.contains("\"phase\":\"ready\""));
    assert!(stream_text.contains("http://127.0.0.1:8000/v1"));
    assert!(!stream_text.contains(secret_api_key));

    let (status, snap) = json_req(&agent, &origin, "GET", "/api/snapshot", Some(&auth), None);
    assert_eq!(status, StatusCode::OK);
    assert!(!snap.to_string().contains(secret_api_key));
}
