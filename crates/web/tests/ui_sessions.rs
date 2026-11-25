use std::{
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

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

fn spawn_mock_server(dir: &Path, access_key: &str, extra_args: &[&str]) -> (Server, String) {
    let auth_dir = dir.join("web-auth");
    std::fs::create_dir_all(&auth_dir).unwrap();
    let hash: [u8; 32] = Sha256::digest(access_key.as_bytes()).into();
    std::fs::write(auth_dir.join("access-key.sha256"), hash).unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_colab-playground-web"));
    command
        .env("COLAB_PLAYGROUND_CONFIG_DIR", dir)
        .env_remove("COLAB_PLAYGROUND_BACKEND")
        .args(["--mock", "--no-open", "--port", "0"])
        .args(extra_args)
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
        .timeout_global(Some(Duration::from_secs(10)))
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
fn sessions_and_forwards_end_to_end_contracts_work_in_mock_mode() {
    let dir = tempfile::tempdir().unwrap();
    let key = "test-sessions-ui-key";
    let (_server, origin) = spawn_mock_server(dir.path(), key, &[]);
    let agent = client();
    let auth = login(&agent, &origin, key);

    // 1. Sessions listing returns demo managed + unmanaged runtimes across both accounts.
    let (status, sessions) = json_req(&agent, &origin, "GET", "/api/sessions", Some(&auth), None);
    assert_eq!(status, StatusCode::OK);
    let runtimes = sessions["runtimes"].as_array().unwrap();
    assert_eq!(runtimes.len(), 4);
    assert!(runtimes.iter().any(|r| r["managed"] == true));
    assert!(runtimes.iter().any(|r| r["managed"] == false));
    assert!(sessions["sampled_at"].as_u64().unwrap() > 0);
    let account_context = sessions["account_context"].clone();

    let managed = runtimes
        .iter()
        .find(|r| r["managed"] == true && r["on_active_account"] == true)
        .unwrap()
        .clone();
    let unmanaged = runtimes
        .iter()
        .find(|r| r["managed"] == false)
        .unwrap()
        .clone();

    // 2. Template pre-fills Defaults with an auto-generated session name.
    let (status, template) = json_req(
        &agent,
        &origin,
        "GET",
        "/api/sessions/template",
        Some(&auth),
        None,
    );
    assert_eq!(status, StatusCode::OK);
    assert!(!template["name"].as_str().unwrap().is_empty());
    assert!(template["guard"]["max_runtime"].as_u64().unwrap() > 0);

    // 3. Auto-stop extend, cancel, and re-set return watchdog state.
    let (status, extended) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/sessions/auto-stop",
        Some(&auth),
        Some(&serde_json::json!({
            "account_context": account_context,
            "target": managed["id"],
            "action": { "kind": "extend", "seconds": 3600 },
        })),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(extended["watchdog_armed"], true);

    let (status, cancelled) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/sessions/auto-stop",
        Some(&auth),
        Some(&serde_json::json!({
            "account_context": account_context,
            "target": managed["id"],
            "action": { "kind": "cancel" },
        })),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled["app_limit_seconds"], serde_json::Value::Null);

    let (status, rearmed) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/sessions/auto-stop",
        Some(&auth),
        Some(&serde_json::json!({
            "account_context": account_context,
            "target": managed["id"],
            "action": { "kind": "set", "seconds": 7200 },
        })),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rearmed["watchdog_armed"], true);

    // 4. Port forwarding: reserved port 8080 rejected; loopback listener rejects all_interfaces;
    //    default loopback succeeds and close reports billing_continues.
    let (status, reserved) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/forwards",
        Some(&auth),
        Some(&serde_json::json!({
            "account_context": account_context,
            "account": managed["id"]["account"],
            "session": managed["id"]["name"],
            "bind": "loopback",
            "local_port": 18080,
            "remote_port": 8080,
            "health_path": null,
        })),
    );
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reserved["error"]["kind"], "port_reserved");

    let (status, blocked_all) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/forwards",
        Some(&auth),
        Some(&serde_json::json!({
            "account_context": account_context,
            "account": managed["id"]["account"],
            "session": managed["id"]["name"],
            "bind": "all_interfaces",
            "local_port": 18001,
            "remote_port": 8000,
            "health_path": null,
        })),
    );
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        blocked_all["error"]["message_key"],
        "web.forward.bind_loopback_listener"
    );

    let (status, opened) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/forwards",
        Some(&auth),
        Some(&serde_json::json!({
            "account_context": account_context,
            "account": managed["id"]["account"],
            "session": managed["id"]["name"],
            "bind": "loopback",
            "local_port": 18002,
            "remote_port": 8000,
            "health_path": "/health",
        })),
    );
    assert_eq!(status, StatusCode::CREATED);
    let forward_id = opened["id"].as_u64().unwrap();
    assert_eq!(opened["addresses"]["open_url"], "http://127.0.0.1:18002");

    let (status, closed) = json_req(
        &agent,
        &origin,
        "DELETE",
        &format!("/api/forwards/{forward_id}"),
        Some(&auth),
        Some(&serde_json::json!({})),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(closed["billing_continues"], true);
    assert_eq!(closed["notice_key"], "app.b2.forward_closed_billing");

    // 5. Stopping an unmanaged runtime requires confirmation and removes it.
    let (status, unconfirmed) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/sessions/stop",
        Some(&auth),
        Some(&serde_json::json!({ "target": unmanaged["id"], "confirmed": false })),
    );
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(unconfirmed["error"]["message_key"], "app.b2.stop_wiped");

    let (status, _) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/sessions/stop",
        Some(&auth),
        Some(&serde_json::json!({ "target": unmanaged["id"], "confirmed": true })),
    );
    assert_eq!(status, StatusCode::NO_CONTENT);

    // 6. Stop all and verify stops all remaining runtimes across all accounts.
    let (status, stop_all_report) = json_req(
        &agent,
        &origin,
        "POST",
        "/api/sessions/stop-all",
        Some(&auth),
        Some(&serde_json::json!({ "confirmed": true })),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stop_all_report["verified"], true);
    assert!(stop_all_report["remaining"].as_array().unwrap().is_empty());
}
