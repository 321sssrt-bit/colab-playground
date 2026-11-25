use std::{
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

use sha2::{Digest as _, Sha256};

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

#[test]
fn accounts_ui_end_to_end_http_contract_against_mock_server() {
    use ureq::{
        Agent,
        http::{Request, StatusCode},
    };

    let dir = tempfile::tempdir().unwrap();
    let key = "accounts-ui-test-key";
    let (_server, origin) = spawn_mock_server(dir.path(), key);
    let agent: Agent = Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();

    let send = |method: &str, path: &str, auth: Option<&str>, body: Option<&str>| {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{origin}{path}"))
            .header("Origin", origin.as_str());
        if let Some(token) = auth {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        let payload = if let Some(json) = body {
            req = req.header("Content-Type", "application/json");
            json.to_owned()
        } else {
            String::new()
        };
        let mut resp = agent.run(req.body(payload).unwrap()).unwrap();
        let status = resp.status();
        let text = resp.body_mut().read_to_string().unwrap();
        let value: Option<serde_json::Value> = if text.is_empty() {
            None
        } else {
            Some(serde_json::from_str(&text).unwrap())
        };
        (status, value)
    };

    let (st, cred) = send(
        "POST",
        "/api/login",
        None,
        Some(&serde_json::json!({ "access_key": key }).to_string()),
    );
    assert_eq!(st, StatusCode::OK);
    let token = cred.unwrap()["token"].as_str().unwrap().to_owned();

    // Wait for initial mock backend poll to populate accounts and usage.
    let mut accounts = None;
    for _ in 0..40 {
        let (st, body) = send("GET", "/api/accounts", Some(&token), None);
        if st == StatusCode::OK {
            let val = body.unwrap();
            let has_usage = val["usage"]
                .as_array()
                .is_some_and(|arr| arr.iter().any(|u| !u["snapshot"].is_null()));
            if has_usage {
                accounts = Some(val);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let accounts = accounts.expect("mock accounts and usage loaded");
    let active_id = accounts["accounts"]["active"].as_str().unwrap().to_owned();
    let other_id = accounts["accounts"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|a| {
            let id = a["id"].as_str()?;
            (id != active_id).then(|| id.to_owned())
        })
        .expect("second mock account present");

    // Usage refresh succeeds.
    let (st, refreshed) = send(
        "POST",
        "/api/accounts/usage/refresh",
        Some(&token),
        Some("{}"),
    );
    assert_eq!(st, StatusCode::OK);
    let refreshed = refreshed.unwrap();
    assert!(refreshed["usage"].as_array().unwrap().len() >= 2);

    // Active account cannot be removed.
    let ctx = refreshed["account_context"].clone();
    let (st, err_body) = send(
        "DELETE",
        &format!("/api/accounts/{active_id}"),
        Some(&token),
        Some(&serde_json::json!({ "account_context": ctx }).to_string()),
    );
    assert_eq!(st, StatusCode::CONFLICT, "body: {err_body:?}");
    assert_eq!(
        err_body.unwrap()["error"]["message_key"].as_str(),
        Some("app.accounts.remove_active")
    );

    // Begin OAuth login and cancel cleanly, keeping previous active account.
    let (st, prompt) = send(
        "POST",
        "/api/accounts/login",
        Some(&token),
        Some(&serde_json::json!({ "account_context": ctx }).to_string()),
    );
    assert_eq!(st, StatusCode::CREATED);
    let prompt = prompt.unwrap();
    let login_id = prompt["id"].as_u64().unwrap();
    let auth_url = prompt["auth_url"].as_str().unwrap();
    assert!(
        auth_url.starts_with("https://"),
        "unexpected auth_url: {auth_url}"
    );

    let (st, _) = send(
        "DELETE",
        &format!("/api/accounts/login/{login_id}"),
        Some(&token),
        Some("{}"),
    );
    assert_eq!(st, StatusCode::NO_CONTENT);

    // Switch preview returns impact checklist and approval token; confirming switches active account.
    let (st, preview) = send(
        "GET",
        &format!("/api/accounts/{other_id}/switch"),
        Some(&token),
        None,
    );
    assert_eq!(st, StatusCode::OK);
    let preview = preview.unwrap();
    assert!(
        !preview["impact"]["sessions_left_running"]
            .as_array()
            .unwrap()
            .is_empty(),
        "demo active account should report managed runtimes left running"
    );
    assert!(
        !preview["impact"]["unmanaged_left_running"]
            .as_array()
            .unwrap()
            .is_empty(),
        "demo active account should report unmanaged runtimes left running"
    );

    let approval = serde_json::json!({
        "account_context": preview["account_context"],
        "confirmation": preview["confirmation"],
    });
    let (st, switched) = send(
        "POST",
        &format!("/api/accounts/{other_id}/switch"),
        Some(&token),
        Some(&approval.to_string()),
    );
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        switched.unwrap()["active"].as_str(),
        Some(other_id.as_str())
    );
}
