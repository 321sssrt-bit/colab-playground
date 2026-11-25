use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

use colab_playground_shared::i18n::CATALOGS;
use colab_playground_web::assets::{FAVICON, SHELL_CATALOGS, STATIC_ASSETS, lookup};
use serde::Deserialize;
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

#[derive(Debug, Default)]
struct HtmlRefs {
    scripts: Vec<(usize, String)>,
    stylesheets: Vec<(usize, String)>,
    icons: Vec<(usize, String)>,
}

fn parse_html_attrs(tag_body: &str) -> BTreeMap<String, String> {
    let mut attrs = BTreeMap::new();
    let mut rest = tag_body;
    while !rest.is_empty() {
        rest = rest.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == '/');
        if rest.is_empty() {
            break;
        }
        let name_end = rest
            .find(|ch: char| ch.is_ascii_whitespace() || matches!(ch, '=' | '/'))
            .unwrap_or(rest.len());
        if name_end == 0 {
            rest = &rest[1..];
            continue;
        }
        let name = rest[..name_end].to_ascii_lowercase();
        rest = rest[name_end..].trim_start();
        let value = if let Some(after_eq) = rest.strip_prefix('=') {
            let rhs = after_eq.trim_start();
            match rhs.as_bytes().first() {
                Some(&quote @ (b'"' | b'\'')) => {
                    let tail = &rhs[1..];
                    let end = tail.find(char::from(quote)).unwrap_or(tail.len());
                    let val = &tail[..end];
                    rest = if end < tail.len() {
                        &tail[end + 1..]
                    } else {
                        ""
                    };
                    val.to_owned()
                }
                _ => {
                    let end = rhs
                        .find(|ch: char| ch.is_ascii_whitespace() || ch == '/')
                        .unwrap_or(rhs.len());
                    let val = &rhs[..end];
                    rest = &rhs[end..];
                    val.to_owned()
                }
            }
        } else {
            String::new()
        };
        attrs.insert(name, value);
    }
    attrs
}

fn extract_html_refs(html: &str) -> HtmlRefs {
    let mut refs = HtmlRefs::default();
    let mut cursor = 0;
    while let Some(rel_lt) = html[cursor..].find('<') {
        let lt = cursor + rel_lt;
        if html[lt..].starts_with("<!--") {
            let Some(rel_end) = html[lt + 4..].find("-->") else {
                break;
            };
            cursor = lt + 4 + rel_end + 3;
            continue;
        }
        let Some(rel_gt) = html[lt + 1..].find('>') else {
            break;
        };
        let gt = lt + 1 + rel_gt;
        let inner = html[lt + 1..gt].trim();
        cursor = gt + 1;
        if inner.is_empty() || inner.starts_with('/') || inner.starts_with('!') {
            continue;
        }
        let name_end = inner
            .find(|ch: char| ch.is_ascii_whitespace() || ch == '/')
            .unwrap_or(inner.len());
        let tag = inner[..name_end].to_ascii_lowercase();
        let attrs = parse_html_attrs(&inner[name_end..]);
        match tag.as_str() {
            "script" => {
                if let Some(src) = attrs.get("src") {
                    refs.scripts.push((lt, src.clone()));
                }
            }
            "link" => {
                let rel_tokens: Vec<&str> = attrs
                    .get("rel")
                    .map(|rel| rel.split_ascii_whitespace().collect())
                    .unwrap_or_default();
                if let Some(href) = attrs.get("href") {
                    if rel_tokens
                        .iter()
                        .any(|tok| tok.eq_ignore_ascii_case("stylesheet"))
                    {
                        refs.stylesheets.push((lt, href.clone()));
                    }
                    if rel_tokens
                        .iter()
                        .any(|tok| tok.eq_ignore_ascii_case("icon"))
                    {
                        refs.icons.push((lt, href.clone()));
                    }
                }
            }
            _ => {}
        }
    }
    refs
}

#[derive(Deserialize)]
struct FrontendI18nManifest {
    keys: Vec<String>,
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
    assert!(
        !base.contains_key("web.shell.page_upcoming_title")
            && !base.contains_key("web.shell.page_upcoming_body"),
        "retired placeholder keys must be removed from SHELL_CATALOGS"
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
    assert_eq!(root.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    let root_body = root.body_mut().read_to_string().unwrap();

    // Parse built / HTML and verify every referenced script, stylesheet, and icon URL.
    let refs = extract_html_refs(&root_body);
    assert!(
        !refs.scripts.is_empty(),
        "built index.html must reference scripts"
    );
    assert!(
        !refs.stylesheets.is_empty(),
        "built index.html must reference stylesheets"
    );
    assert!(
        !refs.icons.is_empty(),
        "built index.html must reference favicon"
    );

    let theme_init_pos = refs
        .scripts
        .iter()
        .find(|(_, src)| src == "/assets/theme-init.js")
        .map(|(pos, _)| *pos)
        .expect("built index.html must load /assets/theme-init.js");
    let first_css_pos = refs.stylesheets[0].0;
    assert!(
        theme_init_pos < first_css_pos,
        "theme-init.js must execute before stylesheets to avoid theme flash"
    );

    for (url, expected_mime) in refs
        .scripts
        .iter()
        .map(|(_, url)| (url.as_str(), "text/javascript; charset=utf-8"))
        .chain(
            refs.stylesheets
                .iter()
                .map(|(_, url)| (url.as_str(), "text/css; charset=utf-8")),
        )
        .chain(
            refs.icons
                .iter()
                .map(|(_, url)| (url.as_str(), "image/svg+xml")),
        )
    {
        let rel = url
            .strip_prefix("/assets/")
            .unwrap_or_else(|| panic!("index.html asset URL must live under /assets/: {url}"));
        let embedded = lookup(rel)
            .unwrap_or_else(|| panic!("index.html references missing embedded asset {url}"));
        assert_eq!(embedded.content_type, expected_mime, "{url}");

        let mut resp = send("GET", url, &[], "");
        assert_eq!(resp.status(), StatusCode::OK, "{url}");
        assert_eq!(resp.headers()[header::CONTENT_TYPE], expected_mime, "{url}");
        assert_eq!(resp.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(resp.body_mut().read_to_vec().unwrap(), embedded.body);
    }

    // /favicon.ico serves the embedded favicon with identical security headers.
    let mut fav = send("GET", "/favicon.ico", &[], "");
    assert_eq!(fav.status(), StatusCode::OK);
    assert_eq!(fav.headers()[header::CONTENT_TYPE], FAVICON.content_type);
    assert_eq!(fav.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(fav.body_mut().read_to_vec().unwrap(), FAVICON.body);

    // Every embedded static asset resolves with the expected content type and exact bytes.
    for asset in STATIC_ASSETS {
        let mut resp = send("GET", &format!("/assets/{}", asset.path), &[], "");
        assert_eq!(resp.status(), StatusCode::OK, "{}", asset.path);
        assert_eq!(
            resp.headers()[header::CONTENT_TYPE],
            asset.content_type,
            "{}",
            asset.path
        );
        assert_eq!(resp.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(resp.body_mut().read_to_vec().unwrap(), asset.body);
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

    // Every i18n key extracted by the frontend AST checker exists in the merged 5-locale catalog.
    let all_keys = expected_keys.expect("merged dictionary keys");
    let manifest_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("frontend/.generated/i18n-keys.json");
    let manifest_raw = std::fs::read_to_string(&manifest_path).unwrap_or_else(|err| {
        panic!(
            "missing frontend i18n key manifest at {} ({err}); run `pnpm --dir crates/web/frontend run check`",
            manifest_path.display()
        )
    });
    let manifest: FrontendI18nManifest =
        serde_json::from_str(&manifest_raw).expect("valid i18n-keys.json");
    assert!(
        !manifest.keys.is_empty(),
        "frontend i18n key manifest must not be empty"
    );
    for key in &manifest.keys {
        assert!(
            all_keys.contains(key),
            "unknown i18n key {key:?} referenced in frontend/.generated/i18n-keys.json"
        );
    }
}
