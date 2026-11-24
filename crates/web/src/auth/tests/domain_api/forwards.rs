use std::net::{Ipv4Addr, TcpListener};

use colab_playground_core::{Host, backend::RunTarget, plugins::InputValue, tunnel::ForwardBind};
use serde_json::json;

use super::*;

const FORWARDS: &str = "/api/forwards";
const FIRST_HOST: &str = "first.example.test";
const SECOND_HOST: &str = "second.example.test";
const NAMED_SESSION: &str = "a100-7f3a";

fn free_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn form(client: &Client) -> Value {
    let account_context = client.get("/api/snapshot")["account"].clone();
    json!({
        "account": account_context["active"],
        "account_context": account_context,
        "session": NAMED_SESSION,
        "local_port": free_port(),
        "remote_port": free_port(),
        "health_path": "/health"
    })
}

fn open(client: &Client, form: &Value, expected: StatusCode) -> Value {
    json(
        client.request("POST", FORWARDS, &form.to_string()),
        expected,
    )
}

fn from_host(client: &Client, host: &str) -> Value {
    let port = client.origin.rsplit_once(':').unwrap().1;
    let response = client
        .agent
        .run(
            Request::builder()
                .uri(format!("{}{FORWARDS}", client.origin))
                .header("host", format!("{host}:{port}"))
                .header("authorization", format!("Bearer {}", client.token))
                .body("")
                .unwrap(),
        )
        .unwrap();
    json(response, StatusCode::OK)
}

async fn exercise_forwards(
    policy: Option<ForwardPolicy>,
    run: impl FnOnce(Client, Arc<MockBackend>) + Send + 'static,
) {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    exercise_with_policy(
        dir.path(),
        SettingsStore::new(Some(dir.path().into())),
        config,
        policy,
        [FIRST_HOST, SECOND_HOST, "[2001:db8::1]", "0.0.0.0"]
            .map(|name| TrustedHost::parse(name).unwrap())
            .into(),
        |client, backend, _| run(client, backend),
    )
    .await;
}

fn live_events(client: &Client) -> BufReader<impl Read + use<>> {
    let response = client.request("POST", "/api/events", "{}");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut reader = BufReader::new(response.into_body().into_reader());
    assert_eq!(next_event(&mut reader).0, "snapshot");
    reader
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

fn next_forward(reader: &mut impl BufRead, id: &Value) -> Value {
    loop {
        let (name, data) = next_event(reader);
        if name == "forward" && data["id"] == *id {
            return data;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn manual_forward_updates_two_streams_and_closing_keeps_the_runtime() {
    exercise_forwards(None, |client, backend| {
        let mut first = live_events(&client);
        let mut second = live_events(&client);
        let request = form(&client);
        let created = open(&client, &request, StatusCode::CREATED);
        let id = &created["id"];
        assert_eq!(created["spec"]["bind"], "loopback");
        let base = format!("http://127.0.0.1:{}", request["local_port"]);
        assert_eq!(created["addresses"]["open_url"], base);
        assert_eq!(created["addresses"]["copy_url"], base);
        assert_eq!(
            created["addresses"]["openai_base_url"],
            format!("{base}/v1")
        );
        let remote = &from_host(&client, FIRST_HOST)[0]["addresses"];
        assert_eq!(remote["notice_key"], "web.forward.server_local");
        assert!(remote["open_url"].is_null());
        assert!(remote["copy_url"].is_null());
        assert!(remote["openai_base_url"].is_null());

        let expected = |state| json!({"id": id, "event": "state", "state": {"state": state}});
        let health = json!({"id": id, "event": "health", "healthy": true});
        for reader in [&mut first, &mut second] {
            assert_eq!(next_forward(reader, id), expected("starting"));
            assert_eq!(next_forward(reader, id), expected("up"));
            assert_eq!(next_forward(reader, id), health);
        }

        let conflict = open(&client, &request, StatusCode::CONFLICT);
        assert_eq!(conflict["error"]["kind"], "port_in_use");
        let mut reserved = request.clone();
        reserved["remote_port"] = json!(8080);
        let error = open(&client, &reserved, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"]["kind"], "port_reserved");
        let mut explicit = request;
        explicit["bind"] = json!("all_interfaces");
        let denied = open(&client, &explicit, StatusCode::CONFLICT);
        let key = denied["error"]["message_key"].as_str().unwrap();
        if Host::detect().supports_all_interfaces_forward() {
            assert_eq!(key, "web.forward.bind_loopback_listener");
        } else {
            assert_eq!(key, "web.forward.bind_windows_or_wsl");
        }
        assert!(client.get("/api/i18n/en-US")[key].as_str().is_some());

        let closed = json(
            client.request("DELETE", &format!("{FORWARDS}/{id}"), "{}"),
            StatusCode::OK,
        );
        assert_eq!(closed["billing_continues"], true);
        assert_eq!(closed["notice_key"], "app.b2.forward_closed_billing");
        assert_eq!(next_forward(&mut first, id), expected("stopped"));
        assert_eq!(next_forward(&mut second, id), expected("stopped"));
        assert_eq!(client.get(FORWARDS), json!([]));
        assert_eq!(client.get("/api/snapshot")["tunnels"], json!([]));
        assert!(
            backend
                .runtimes(&Default::default())
                .unwrap()
                .runtimes
                .iter()
                .any(|runtime| runtime.id.name.as_deref() == Some(NAMED_SESSION))
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn all_interface_forward_uses_each_validated_host_and_warns_about_auth() {
    if !Host::Local.supports_all_interfaces_forward() {
        return;
    }
    let policy = ForwardPolicy::new(Ipv4Addr::UNSPECIFIED.into(), &Host::Local);
    exercise_forwards(Some(policy), |client, _| {
        let mut request = form(&client);
        request["bind"] = json!("all_interfaces");
        let created = open(&client, &request, StatusCode::CREATED);
        assert_eq!(created["spec"]["bind"], "all_interfaces");
        for host in [FIRST_HOST, SECOND_HOST, "[2001:db8::1]"] {
            let base = format!("http://{host}:{}", request["local_port"]);
            assert_eq!(
                from_host(&client, host)[0]["addresses"],
                json!({
                    "open_url": base,
                    "copy_url": base,
                    "openai_base_url": format!("{base}/v1"),
                    "notice_key": null,
                    "warning_key": "web.forward.downstream_auth"
                })
            );
        }
        assert!(from_host(&client, "0.0.0.0")[0]["addresses"]["open_url"].is_null());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn wsl_rejects_explicit_wide_bind_and_plugin_forward_defaults_to_loopback() {
    let host = Host::Wsl { distro: None };
    let policy = ForwardPolicy::new(Ipv4Addr::UNSPECIFIED.into(), &host);
    exercise_forwards(Some(policy), |client, backend| {
        let mut request = form(&client);
        request["bind"] = json!("all_interfaces");
        let denied = open(&client, &request, StatusCode::CONFLICT);
        assert_eq!(
            denied["error"]["message_key"],
            "web.forward.bind_windows_or_wsl"
        );

        let snapshot = client.web.snapshot();
        let target = snapshot
            .runtimes
            .as_ref()
            .unwrap()
            .runtimes
            .iter()
            .find(|runtime| runtime.id.name.as_deref() == Some(NAMED_SESSION))
            .unwrap()
            .id
            .clone();
        let account = snapshot.account.clone();
        let mut run = backend.plugin_run_template("llama-cpp").unwrap();
        run.inputs.insert(
            "repo".into(),
            InputValue::Text("unsloth/Qwen3-0.6B-GGUF".into()),
        );
        run.target = RunTarget::Existing {
            name: NAMED_SESSION.into(),
        };
        let (events, _) = std::sync::mpsc::channel();
        let Submission::Started { job, .. } = client
            .web
            .run_plugin(account.clone(), run, Some(target), events)
            .unwrap()
        else {
            panic!("expected plugin job");
        };
        let tokio = tokio::runtime::Handle::current();
        let outcome = tokio.block_on(job).unwrap().unwrap();
        let endpoint = &outcome.endpoints[0];
        let error = client
            .web
            .open_plugin_forward(
                account.clone(),
                &outcome,
                endpoint,
                Some(ForwardBind::AllInterfaces),
            )
            .err()
            .unwrap();
        assert_eq!(
            error.param("forward_bind_restriction"),
            Some("windows_or_wsl")
        );

        let mut stream = live_events(&client);
        let Submission::Started { job, .. } = client
            .web
            .open_plugin_forward(account, &outcome, endpoint, None)
            .unwrap()
        else {
            panic!("expected forward job");
        };
        let forward = tokio.block_on(job).unwrap().unwrap();
        let id = json!(forward.id);
        assert_eq!(next_forward(&mut stream, &id)["state"]["state"], "starting");
        assert_eq!(next_forward(&mut stream, &id)["state"]["state"], "up");
        let listed = &from_host(&client, FIRST_HOST)[0];
        assert_eq!(listed["id"], id);
        assert_eq!(listed["spec"]["bind"], "loopback");
        assert_eq!(listed["spec"]["remote_port"], endpoint.remote_port);
        assert_eq!(listed["spec"]["health_path"], json!(endpoint.health));
        assert_eq!(
            listed["addresses"]["notice_key"],
            "web.forward.server_local"
        );
    })
    .await;
}
