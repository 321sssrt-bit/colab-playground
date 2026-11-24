use super::*;

#[tokio::test]
async fn only_the_hash_persists_and_expired_sessions_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let keys = KeyStore::new(dir.path());
    let _lock = InstanceLock::acquire(keys.dir()).unwrap();
    let key = keys.replace().unwrap();
    assert_eq!(std::fs::read(&keys.file).unwrap(), digest(&key));
    let auth = Auth::new(keys);
    let token = auth.login(&key).await.unwrap().unwrap();
    assert!(auth.authenticate(&token).await.is_some());
    *auth
        .sessions
        .lock()
        .await
        .expires
        .get_mut(&digest(&token))
        .unwrap() = Instant::now();
    assert!(auth.authenticate(&token).await.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn http_checks_origins_and_revokes_open_streams_on_rotation() {
    use std::io::{BufRead, BufReader, Read as _};

    use std::sync::Arc;

    use crate::http::{Origins, TrustedHost, router};
    use colab_playground_core::mock::{MockBackend, MockConfig, MockScenario};
    use colab_playground_web::state::{Access, Submission, WebState};

    let dir = tempfile::tempdir().unwrap();
    let keys = KeyStore::new(dir.path());
    let _lock = InstanceLock::acquire(keys.dir()).unwrap();
    let key = keys.replace().unwrap();
    let (_watcher, changes) = keys.watch();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let origin = format!("http://{addr}");
    let authority = addr.to_string();
    let (config, _) = MockConfig::headless(MockScenario::demo());
    let state = WebState::start(Arc::new(MockBackend::new(config)))
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        state
            .subscribe()
            .wait_for(|snapshot| snapshot.runtimes.is_some()),
    )
    .await
    .unwrap()
    .unwrap();
    let app = router(
        Auth::new(KeyStore::new(dir.path())),
        changes,
        Origins::new(
            addr,
            vec![
                TrustedHost::parse("https://console.example").unwrap(),
                TrustedHost::parse("http://plain.example").unwrap(),
                TrustedHost::parse("https://proxy.example:8443").unwrap(),
            ],
        ),
        state.clone(),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    tokio::task::spawn_blocking(move || {
        use ureq::{
            Agent,
            http::{Request, StatusCode, header},
        };

        let agent: Agent = Agent::config_builder()
            .proxy(None)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .into();

        let request = |method: &str, path: &str, headers: &[(&str, &str)], body: &str| {
            let mut request = Request::builder()
                .method(method)
                .uri(format!("{origin}{path}"));
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let response = agent.run(request.body(body.to_owned()).unwrap()).unwrap();
            assert_eq!(
                response.headers()[header::CONTENT_SECURITY_POLICY],
                "default-src 'self'"
            );
            assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(!response.headers().contains_key(header::SET_COOKIE));
            response
        };
        let login = |headers: &[(&str, &str)], key: &str| {
            let payload = serde_json::json!({ "access_key": key }).to_string();
            request("POST", "/api/login", headers, &payload)
        };
        let json = ("Content-Type", "application/json; charset=utf-8");
        let matching_origin = ("Origin", origin.as_str());
        let primary_host = ("Host", authority.as_str());

        for path in ["/", "/missing"] {
            assert_eq!(
                request("GET", path, &[("Host", "rebind.example")], "").status(),
                StatusCode::BAD_REQUEST,
            );
        }
        assert_eq!(
            request("GET", "/", &[("Host", "localhost:1")], "").status(),
            StatusCode::BAD_REQUEST,
        );
        for wrong_origin in [
            "null".to_owned(),
            "http://other.example".to_owned(),
            format!("http://localhost:{}", addr.port()),
            format!("https://{addr}"),
            format!("http://127.0.0.1:{}", if addr.port() == 1 { 2 } else { 1 }),
        ] {
            assert_eq!(
                login(&[json, ("Origin", &wrong_origin)], &key).status(),
                StatusCode::FORBIDDEN,
            );
        }
        assert_eq!(login(&[json], &key).status(), StatusCode::FORBIDDEN);
        assert_eq!(
            login(&[json, matching_origin, matching_origin], &key).status(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            login(&[matching_origin, ("Content-Type", "text/plain")], &key).status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        );
        let mut malformed = request(
            "POST",
            "/api/login?ignored=secret",
            &[matching_origin, json],
            r#"{"access_key":{"secret":true}}"#,
        );
        assert_eq!(malformed.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(malformed.body_mut().read_to_string().unwrap(), "");

        let private = "/api/session";
        assert_eq!(
            request("GET", private, &[], "").status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request("GET", private, &[("Authorization", "Bearer wrong")], "").status(),
            StatusCode::UNAUTHORIZED,
        );
        assert_eq!(
            login(&[matching_origin, json], "wrong").status(),
            StatusCode::UNAUTHORIZED
        );

        let mut tokens = Vec::new();
        for (host, origin) in [
            (authority.as_str(), origin.as_str()),
            ("console.example", "https://console.example"),
            ("plain.example", "http://plain.example"),
            ("proxy.example:8443", "https://proxy.example:8443"),
        ] {
            let mut response = login(&[("Host", host), ("Origin", origin), json], &key);
            assert_eq!(response.status(), StatusCode::OK);
            let credential: serde_json::Value =
                serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap();
            assert_eq!(credential["expires_in"], SESSION_LIFETIME.as_secs());
            tokens.push(format!("Bearer {}", credential["token"].as_str().unwrap()));
        }
        assert_eq!(
            login(
                &[
                    ("Host", "console.example"),
                    ("Origin", "http://console.example"),
                    ("X-Forwarded-Proto", "http"),
                    json
                ],
                &key
            )
            .status(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            login(
                &[
                    ("Host", "console.example"),
                    ("Origin", "https://proxy.example:8443"),
                    json
                ],
                &key
            )
            .status(),
            StatusCode::FORBIDDEN,
        );

        let authorization = ("Authorization", tokens[0].as_str());
        assert_eq!(
            request("GET", private, &[authorization], "").status(),
            StatusCode::NO_CONTENT
        );
        let events = "/api/events";
        assert_eq!(
            request("POST", events, &[authorization, json], "{}").status(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            request("POST", events, &[matching_origin, json], "{}").status(),
            StatusCode::UNAUTHORIZED,
        );
        let open_stream = || {
            request(
                "POST",
                events,
                &[primary_host, matching_origin, json, authorization],
                "{}",
            )
        };
        let read_snapshot = |stream: &mut dyn BufRead| -> serde_json::Value {
            let mut event = String::new();
            let mut id = String::new();
            let mut data = String::new();
            stream.read_line(&mut event).unwrap();
            stream.read_line(&mut id).unwrap();
            stream.read_line(&mut data).unwrap();
            assert_eq!(event, "event: snapshot\n");
            let version: u64 = id.strip_prefix("id: ").unwrap().trim().parse().unwrap();
            let snapshot: serde_json::Value =
                serde_json::from_str(data.strip_prefix("data: ").unwrap()).unwrap();
            assert_eq!(snapshot["version"], version);
            let mut separator = String::new();
            stream.read_line(&mut separator).unwrap();
            assert_eq!(separator, "\n");
            snapshot
        };
        let mut stream = open_stream();
        assert_eq!(stream.status(), StatusCode::OK);
        assert_eq!(stream.headers()[header::CONTENT_TYPE], "text/event-stream");
        let first = read_snapshot(&mut BufReader::new(stream.body_mut().as_reader()));
        assert_eq!(first["account"]["active"], "mock1");
        assert_eq!(first["runtimes"]["runtimes"].as_array().unwrap().len(), 4);

        let (release, held) = std::sync::mpsc::channel();
        let Submission::Started { id, job } = state
            .start_operation(
                "held",
                "one".into(),
                Access::Independent,
                move |_, cancel| {
                    held.recv_timeout(Duration::from_secs(5)).unwrap();
                    cancel.check()
                },
            )
            .unwrap()
        else {
            panic!("expected to start a job");
        };
        let live = read_snapshot(&mut BufReader::new(stream.body_mut().as_reader()));
        assert_eq!(live["operations"][0]["id"], id);
        drop(stream);

        let mut fetched = request("GET", "/api/snapshot", &[authorization], "");
        let fetched: serde_json::Value =
            serde_json::from_str(&fetched.body_mut().read_to_string().unwrap()).unwrap();
        assert_eq!(fetched["operations"][0]["id"], id);
        let mut stream = open_stream();
        let mut stream = BufReader::new(stream.body_mut().as_reader());
        let reconnected = read_snapshot(&mut stream);
        assert!(reconnected["version"].as_u64() > first["version"].as_u64());
        assert_eq!(reconnected["operations"][0]["id"], id);
        release.send(()).unwrap();
        tokio::runtime::Handle::current()
            .block_on(job)
            .unwrap()
            .unwrap();
        let finished = read_snapshot(&mut stream);
        assert!(finished["version"].as_u64() > reconnected["version"].as_u64());
        assert!(finished["operations"].as_array().unwrap().is_empty());

        let new_key = keys.replace().unwrap();
        for token in &tokens {
            assert_eq!(
                request("GET", private, &[("Authorization", token)], "").status(),
                StatusCode::UNAUTHORIZED,
            );
        }
        assert_eq!(
            login(&[matching_origin, json], &key).status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            login(&[matching_origin, json], &new_key).status(),
            StatusCode::OK
        );
        let mut tail = String::new();
        stream.read_to_string(&mut tail).unwrap();
        assert_eq!(tail, "");
    })
    .await
    .unwrap();

    server.abort();
}
