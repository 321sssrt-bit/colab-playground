use std::{
    fs,
    io::{BufRead as _, BufReader},
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

use serde_json::Value;
use sha2::{Digest as _, Sha256};
use ureq::{
    Agent, Body,
    http::{Request, Response, StatusCode},
};

const PORT_START: u16 = 18220;
const PORT_END: u16 = 18239;
const ACCESS_KEY: &str = "updates-api-integration-test-key";
const VERSION: &str = env!("CARGO_PKG_VERSION");

struct RunningServer {
    child: Child,
    origin: String,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pick_isolated_port() -> u16 {
    for port in PORT_START..=PORT_END {
        if let Ok(listener) = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))) {
            drop(listener);
            return port;
        }
    }
    0
}

fn spawn_web(dir: &Path) -> RunningServer {
    let auth_dir = dir.join("web-auth");
    fs::create_dir_all(&auth_dir).unwrap();
    let digest = Sha256::digest(ACCESS_KEY.as_bytes());
    fs::write(auth_dir.join("access-key.sha256"), digest).unwrap();

    let port = pick_isolated_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_colab-playground-web"))
        .env("COLAB_PLAYGROUND_CONFIG_DIR", dir)
        .env_remove("COLAB_PLAYGROUND_BACKEND")
        .args(["--mock", "--no-open", "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    let addr = line
        .strip_prefix("Web Server listening on ")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("unexpected startup line: {line:?}"))
        .to_owned();
    RunningServer {
        child,
        origin: format!("http://{addr}"),
    }
}

fn agent() -> Agent {
    Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into()
}

fn send(
    agent: &Agent,
    origin: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("{origin}{path}"))
        .header("origin", origin)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    agent.run(builder.body(body.to_owned()).unwrap()).unwrap()
}

fn json(mut response: Response<Body>, expected: StatusCode) -> Value {
    assert_eq!(response.status(), expected);
    serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap()
}

fn login(agent: &Agent, origin: &str) -> String {
    let payload = serde_json::json!({ "access_key": ACCESS_KEY }).to_string();
    let credential = json(
        send(agent, origin, "POST", "/api/login", None, &payload),
        StatusCode::OK,
    );
    credential["token"].as_str().unwrap().to_owned()
}

#[test]
fn updates_throttle_manual_refresh_and_auto_check_toggle_persist_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let agent = agent();

    let checked_at = {
        let server = spawn_web(dir.path());
        let token = login(&agent, &server.origin);

        // Auto-check starts enabled and can be turned off persistently.
        let settings = json(
            send(
                &agent,
                &server.origin,
                "GET",
                "/api/settings",
                Some(&token),
                "",
            ),
            StatusCode::OK,
        );
        assert_eq!(settings["check_updates"], true);

        let disabled = json(
            send(
                &agent,
                &server.origin,
                "PATCH",
                "/api/settings",
                Some(&token),
                r#"{"check_updates":false}"#,
            ),
            StatusCode::OK,
        );
        assert_eq!(disabled["check_updates"], false);

        // With auto-check off, GET /api/updates skips checking and still returns the compiled version.
        let idle = json(
            send(
                &agent,
                &server.origin,
                "GET",
                "/api/updates",
                Some(&token),
                "",
            ),
            StatusCode::OK,
        );
        assert_eq!(idle["current_version"], VERSION);
        assert_eq!(idle["status"], "idle");
        assert_eq!(idle["update_available"], false);
        assert_eq!(idle["check_updates"], false);
        assert!(idle["checked_at"].is_null());
        assert_eq!(
            idle["releases_url"],
            "https://github.com/321sssrt-bit/colab-playground/releases"
        );

        // Explicit manual check bypasses the toggle and persists `update_checked_at`.
        let manual = json(
            send(
                &agent,
                &server.origin,
                "POST",
                "/api/updates/check",
                Some(&token),
                "{}",
            ),
            StatusCode::OK,
        );
        assert_eq!(manual["current_version"], VERSION);
        assert_eq!(manual["status"], "up_to_date");
        assert_eq!(manual["update_available"], false);
        assert_eq!(manual["check_updates"], false);
        assert!(manual["error"].is_null());
        let checked_at = manual["checked_at"].as_u64().expect("checked_at saved");

        // Read-only release contract stays enforced.
        assert_eq!(
            send(
                &agent,
                &server.origin,
                "POST",
                "/api/updates",
                Some(&token),
                "{}"
            )
            .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            send(
                &agent,
                &server.origin,
                "POST",
                "/api/updates/install",
                Some(&token),
                "{}"
            )
            .status(),
            StatusCode::NOT_FOUND
        );

        // Re-enable auto-check before restarting so the restart tests the 24h persisted throttle.
        let reenabled = json(
            send(
                &agent,
                &server.origin,
                "PATCH",
                "/api/settings",
                Some(&token),
                r#"{"check_updates":true}"#,
            ),
            StatusCode::OK,
        );
        assert_eq!(reenabled["check_updates"], true);
        checked_at
    };

    // Restart with the same config directory: 24h throttle prevents a fresh check and keeps state.
    let server = spawn_web(dir.path());
    let token = login(&agent, &server.origin);
    let after_restart = json(
        send(
            &agent,
            &server.origin,
            "GET",
            "/api/updates",
            Some(&token),
            "",
        ),
        StatusCode::OK,
    );
    assert_eq!(after_restart["current_version"], VERSION);
    assert_eq!(after_restart["status"], "idle");
    assert_eq!(after_restart["update_available"], false);
    assert_eq!(after_restart["checked_at"], checked_at);
    assert_eq!(after_restart["check_updates"], true);
    assert_eq!(
        after_restart["releases_url"],
        "https://github.com/321sssrt-bit/colab-playground/releases"
    );
}
