use std::net::Ipv4Addr;

use colab_playground_core::{
    Host,
    backend::{PluginRunOutcome, RunTarget},
    plugins::InputValue,
    tunnel::ForwardBind,
};
use colab_playground_web::state::AccountContext;
use serde_json::json;

use super::*;

const FORWARDS: &str = "/api/forwards";
const FIRST_HOST: &str = "first.example.test";
const SECOND_HOST: &str = "second.example.test";
const NAMED_SESSION: &str = "a100-7f3a";

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
    let (authority, origin) = if host == FIRST_HOST {
        (host.to_owned(), format!("https://{host}"))
    } else {
        (format!("{host}:{port}"), format!("http://{host}:{port}"))
    };
    let response = client
        .agent
        .run(
            Request::builder()
                .uri(format!("{}{FORWARDS}", client.origin))
                .header("host", authority)
                .header("origin", origin)
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
        [
            "https://first.example.test",
            SECOND_HOST,
            "[2001:db8::1]",
            "0.0.0.0",
        ]
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
    exercise_forwards(Some(policy), |client, backend| {
        let mut request = form(&client);
        request["bind"] = json!("all_interfaces");
        let created = open(&client, &request, StatusCode::CREATED);
        assert_eq!(created["spec"]["bind"], "all_interfaces");
        for host in [FIRST_HOST, SECOND_HOST] {
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
        for host in ["0.0.0.0", "[2001:db8::1]"] {
            let addresses = &from_host(&client, host)[0]["addresses"];
            assert!(addresses["open_url"].is_null());
            assert_eq!(addresses["notice_key"], "web.forward.external_host");
        }
        let (account, outcome) = ready_plugin(&client, &backend);
        let endpoint = &outcome.endpoints[0];
        let Submission::Started { job, .. } = client
            .web
            .open_plugin_forward(
                account,
                &outcome,
                endpoint,
                Some(ForwardBind::AllInterfaces),
            )
            .unwrap()
        else {
            panic!("expected forward job");
        };
        let id = json!(
            tokio::runtime::Handle::current()
                .block_on(job)
                .unwrap()
                .unwrap()
                .id
        );
        let listed = from_host(&client, SECOND_HOST);
        let plugin = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|view| view["id"] == id)
            .unwrap();
        let base = format!("http://{SECOND_HOST}:{}", endpoint.remote_port);
        assert_eq!(plugin["addresses"]["open_url"], base);
        assert_eq!(plugin["addresses"]["copy_url"], format!("{base}/v1"));
        assert_eq!(plugin["addresses"]["openai_base_url"], format!("{base}/v1"));
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

        let (account, outcome) = ready_plugin(&client, &backend);
        let tokio = tokio::runtime::Handle::current();
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

fn ready_plugin(client: &Client, backend: &MockBackend) -> (AccountContext, PluginRunOutcome) {
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
    (
        account,
        tokio::runtime::Handle::current()
            .block_on(job)
            .unwrap()
            .unwrap(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn immediate_ssh_failure_is_reported_and_discarded() {
    exercise_forwards(None, |client, backend| {
        backend.set_failures(MockFailures {
            ssh_busy_attempts: 1,
            ..Default::default()
        });
        let request = form(&client);
        let failed = open(&client, &request, StatusCode::CONFLICT);
        assert_eq!(failed["error"]["kind"], "ssh_busy");
        assert_eq!(client.get(FORWARDS), json!([]));
        assert!(backend.tunnels().is_empty());
        assert_eq!(
            open(&client, &request, StatusCode::CREATED)["state"]["state"],
            "up"
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn login_closes_forwards_while_guard_polling_is_paused() {
    exercise_forwards(None, |client, _| {
        let mut stream = live_events(&client);
        let created = open(&client, &form(&client), StatusCode::CREATED);
        let id = &created["id"];
        assert_eq!(next_forward(&mut stream, id)["state"]["state"], "starting");
        assert_eq!(next_forward(&mut stream, id)["state"]["state"], "up");
        assert_eq!(next_forward(&mut stream, id)["event"], "health");

        let Submission::Started { job, .. } = client
            .web
            .begin_login(client.web.snapshot().account.clone())
            .unwrap()
        else {
            panic!("expected a login job");
        };
        let prompt = tokio::runtime::Handle::current()
            .block_on(job)
            .unwrap()
            .unwrap();
        assert_eq!(next_forward(&mut stream, id)["state"]["state"], "stopped");
        assert_eq!(client.get("/api/snapshot")["login_id"], prompt.id);
        assert_eq!(client.get(FORWARDS), json!([]));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn overview_reports_forward_policy_for_loopback_wide_and_wsl_hosts() {
    if Host::Local.supports_all_interfaces_forward() {
        let local_loopback = ForwardPolicy::new(Ipv4Addr::LOCALHOST.into(), &Host::Local);
        exercise_forwards(Some(local_loopback), |client, _| {
            let overview = client.get("/api/overview");
            assert_eq!(
                overview["forward_policy"],
                json!({
                    "all_interfaces_allowed": false,
                    "restriction": "loopback_listener",
                })
            );
        })
        .await;

        let local_wide = ForwardPolicy::new(Ipv4Addr::UNSPECIFIED.into(), &Host::Local);
        exercise_forwards(Some(local_wide), |client, _| {
            let overview = client.get("/api/overview");
            assert_eq!(
                overview["forward_policy"],
                json!({
                    "all_interfaces_allowed": true,
                    "restriction": Value::Null,
                })
            );
        })
        .await;
    }

    let wsl_host = Host::Wsl { distro: None };
    let wsl_wide = ForwardPolicy::new(Ipv4Addr::UNSPECIFIED.into(), &wsl_host);
    exercise_forwards(Some(wsl_wide), |client, _| {
        let overview = client.get("/api/overview");
        assert_eq!(
            overview["forward_policy"],
            json!({
                "all_interfaces_allowed": false,
                "restriction": "windows_or_wsl",
            })
        );
    })
    .await;
}
