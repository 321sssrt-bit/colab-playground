use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

use colab_playground_shared::i18n::CATALOGS;
use colab_playground_web::assets::{INDEX, SHELL_CATALOGS, STATIC_ASSETS};
use sha2::{Digest as _, Sha256};

fn placeholders(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut rest = text;
    while let Some((_, after_open)) = rest.split_once('{') {
        if let Some((name, after_close)) = after_open.split_once('}') {
            if !name.is_empty()
                && name
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            {
                found.insert(name.to_owned());
            }
            rest = after_close;
        } else {
            break;
        }
    }
    found
}

#[test]
fn shell_catalog_has_five_locale_parity_and_no_shared_key_collisions() {
    assert_eq!(
        CATALOGS.map(|(tag, _)| tag),
        SHELL_CATALOGS.map(|(tag, _)| tag)
    );
    let shared_keys: BTreeSet<&str> = CATALOGS[0].1.iter().map(|(key, _)| *key).collect();
    let base: BTreeMap<&str, &str> = SHELL_CATALOGS[0].1.iter().copied().collect();
    assert_eq!(
        base.len(),
        SHELL_CATALOGS[0].1.len(),
        "duplicate keys in en-US"
    );
    let base_keys: BTreeSet<&str> = base.keys().copied().collect();
    assert!(
        shared_keys.is_disjoint(&base_keys),
        "shell catalog must not collide with shared i18n keys"
    );

    for (tag, entries) in SHELL_CATALOGS {
        let map: BTreeMap<&str, &str> = entries.iter().copied().collect();
        assert_eq!(map.len(), entries.len(), "duplicate keys in {tag}");
        let keys: BTreeSet<&str> = map.keys().copied().collect();
        assert_eq!(keys, base_keys, "key set mismatch for {tag}");
        for (&key, &value) in &map {
            assert!(!value.trim().is_empty(), "empty value for {key} in {tag}");
            assert_eq!(
                placeholders(value),
                placeholders(base[key]),
                "placeholder mismatch for {key} in {tag}"
            );
        }
    }
}

#[test]
fn embedded_assets_forbid_inline_scripts_styles_hardcoded_colors_and_html_copy() {
    let html = INDEX.body;
    // Every <script> tag must reference an external same-origin src and have an empty body.
    for segment in html.split("<script").skip(1) {
        let (open_tag, rest) = segment.split_once('>').expect("closing script tag bracket");
        assert!(
            open_tag.contains("src=\"/assets/"),
            "script tag must load from /assets/: {open_tag}"
        );
        let (body, _) = rest.split_once("</script>").expect("closing </script>");
        assert!(
            body.trim().is_empty(),
            "inline script content is forbidden under CSP default-src 'self': {body}"
        );
    }
    assert!(!html.contains("<style"), "inline <style> is forbidden");
    assert!(
        !html.contains("style="),
        "inline style= attribute is forbidden"
    );
    for handler in ["onclick=", "onchange=", "oninput=", "onsubmit="] {
        assert!(!html.contains(handler), "inline {handler} is forbidden");
    }

    // Body of index.html must contain zero hardcoded user-visible text nodes.
    let body_section = html
        .split("<body>")
        .nth(1)
        .and_then(|rest| rest.split("</body>").next())
        .expect("html body");
    let mut in_tag = false;
    let mut text_chars = String::new();
    for ch in body_section.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text_chars.push(ch),
            _ => {}
        }
    }
    assert!(
        text_chars.trim().is_empty(),
        "index.html body must not contain hardcoded user-visible copy: {text_chars:?}"
    );

    // Non-token CSS must never contain hardcoded color literals.
    for asset in STATIC_ASSETS {
        if asset.path.ends_with(".css") && asset.path != "styles/tokens.css" {
            for (line_no, line) in asset.body.lines().enumerate() {
                let code = line.split("/*").next().unwrap_or("");
                assert!(
                    !code.contains('#'),
                    "hardcoded hex color in {}:{}: {line}",
                    asset.path,
                    line_no + 1
                );
                for fn_name in ["rgb(", "rgba(", "hsl(", "hsla(", "oklch(", "oklab("] {
                    assert!(
                        !code.contains(fn_name),
                        "hardcoded color function {fn_name} in {}:{}: {line}",
                        asset.path,
                        line_no + 1
                    );
                }
            }
        }
        if asset.path.ends_with(".js") {
            let code_only: String = asset
                .body
                .lines()
                .map(|line| line.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !code_only.contains("innerHTML"),
                "innerHTML is forbidden in {}",
                asset.path
            );
            assert!(
                !code_only.contains("document.cookie"),
                "cookies are forbidden in {}",
                asset.path
            );
            assert!(
                !code_only.contains("EventSource"),
                "native EventSource is forbidden in {} (use fetch SSE with Bearer)",
                asset.path
            );
            assert!(
                !code_only.contains(".style."),
                "inline .style.* mutation is forbidden in {} (use CSS classes/tokens)",
                asset.path
            );
        }
    }
}

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
fn static_routes_csp_headers_and_public_i18n_work_without_cookies() {
    use ureq::{
        Agent,
        http::{Request, StatusCode, header},
    };

    let dir = tempfile::tempdir().unwrap();
    let key = "test-web-access-key-only";
    let (_server, origin) = spawn_mock_server(dir.path(), key);
    let agent: Agent = Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();

    let send = |method: &str, path: &str, headers: &[(&str, &str)], body: &str| {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{origin}{path}"));
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let resp = agent.run(req.body(body.to_owned()).unwrap()).unwrap();
        assert_eq!(
            resp.headers()[header::CONTENT_SECURITY_POLICY],
            "default-src 'self'"
        );
        assert_eq!(resp.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!resp.headers().contains_key(header::SET_COOKIE));
        resp
    };

    // Index document at /
    let mut root = send("GET", "/", &[], "");
    assert_eq!(root.status(), StatusCode::OK);
    assert_eq!(
        root.headers()[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    let root_body = root.body_mut().read_to_string().unwrap();
    assert!(root_body.contains("/assets/js/main.js"));
    assert!(root_body.contains("/assets/styles/tokens.css"));

    // Every embedded static asset resolves with the expected content type.
    for asset in STATIC_ASSETS {
        let resp = send("GET", &format!("/assets/{}", asset.path), &[], "");
        assert_eq!(resp.status(), StatusCode::OK, "{}", asset.path);
        assert_eq!(
            resp.headers()[header::CONTENT_TYPE],
            asset.content_type,
            "{}",
            asset.path
        );
        assert_eq!(resp.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    }

    // Missing assets and bad host are rejected cleanly.
    assert_eq!(
        send("GET", "/assets/does-not-exist.js", &[], "").status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send("GET", "/assets/i18n/fr-FR.json", &[], "").status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send("GET", "/assets/i18n/en-US", &[], "").status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send("GET", "/", &[("Host", "evil.example")], "").status(),
        StatusCode::BAD_REQUEST
    );

    // /api/i18n/{locale} remains protected by Bearer authentication.
    assert_eq!(
        send("GET", "/api/i18n/en-US", &[], "").status(),
        StatusCode::UNAUTHORIZED
    );

    // Login with Web access key and verify zero key collision between /api/i18n and shell supplement.
    let mut login = send(
        "POST",
        "/api/login",
        &[
            ("Origin", origin.as_str()),
            ("Content-Type", "application/json"),
        ],
        &serde_json::json!({ "access_key": key }).to_string(),
    );
    assert_eq!(login.status(), StatusCode::OK);
    let cred: serde_json::Value =
        serde_json::from_str(&login.body_mut().read_to_string().unwrap()).unwrap();
    let auth = format!("Bearer {}", cred["token"].as_str().unwrap());

    let mut api_dict_resp = send("GET", "/api/i18n/en-US", &[("Authorization", &auth)], "");
    assert_eq!(api_dict_resp.status(), StatusCode::OK);
    let api_dict: BTreeMap<String, String> =
        serde_json::from_str(&api_dict_resp.body_mut().read_to_string().unwrap()).unwrap();

    let shell_keys: BTreeSet<&str> = SHELL_CATALOGS[0].1.iter().map(|(k, _)| *k).collect();
    for key in &shell_keys {
        assert!(
            !api_dict.contains_key(*key),
            "shell supplement key {key} collides with crate::i18n::dictionary"
        );
    }

    // All five public /assets/i18n/{locale}.json dictionaries match keys and contain merged entries.
    let mut expected_keys: Option<BTreeSet<String>> = None;
    for (tag, _) in SHELL_CATALOGS {
        let mut resp = send("GET", &format!("/assets/i18n/{tag}.json"), &[], "");
        assert_eq!(resp.status(), StatusCode::OK, "{tag}");
        let dict: BTreeMap<String, String> =
            serde_json::from_str(&resp.body_mut().read_to_string().unwrap()).unwrap();
        assert_eq!(
            dict.len(),
            api_dict.len() + shell_keys.len(),
            "merged dictionary count mismatch for {tag}"
        );
        let keys: BTreeSet<String> = dict.keys().cloned().collect();
        if let Some(expected) = &expected_keys {
            assert_eq!(&keys, expected, "public dictionary keys mismatch for {tag}");
        } else {
            expected_keys = Some(keys);
        }
    }

    // Every literal t("...") call referenced in embedded JS exists in the merged 5-locale catalog.
    let all_keys = expected_keys.expect("merged dictionary keys");
    for asset in STATIC_ASSETS.iter().filter(|a| a.path.ends_with(".js")) {
        let bytes = asset.body.as_bytes();
        let mut cursor = 0;
        while let Some(offset) = asset.body[cursor..].find("t(\"") {
            let start = cursor + offset;
            let boundary_ok = start == 0
                || !(bytes[start - 1].is_ascii_alphanumeric()
                    || matches!(bytes[start - 1], b'_' | b'$' | b'.'));
            cursor = start + 3;
            if !boundary_ok {
                continue;
            }
            if let Some(end) = asset.body[cursor..].find('"') {
                let key = &asset.body[cursor..cursor + end];
                assert!(
                    all_keys.contains(key),
                    "unknown i18n key {key:?} referenced in {}",
                    asset.path
                );
                cursor += end + 1;
            } else {
                break;
            }
        }
    }
}
