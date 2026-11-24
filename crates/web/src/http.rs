use std::{
    convert::Infallible,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Extension, Request, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header, uri::Authority},
    middleware::{self, Next},
    response::{IntoResponse, Response, Sse, sse::Event},
    routing::{get, post},
};
use futures_util::stream;
use serde::{Deserialize, Serialize, de::IgnoredAny};
use tokio::sync::watch;

use crate::auth::{Auth, SESSION_LIFETIME, Session};

const HTTP_PORT: u16 = 80;
const HTTPS_PORT: u16 = 443;
const EVENTS: &str = "/api/events";
const KEY_BODY_LIMIT: usize = 4096;
const WATCH_FALLBACK: Duration = Duration::from_secs(1);
const HEARTBEAT: Duration = Duration::from_secs(15);

pub struct TrustedHost {
    https: bool,
    host: String,
    port: Option<u16>,
}

impl TrustedHost {
    pub fn parse(input: &str) -> Result<Self, &'static str> {
        const INVALID: &str = "--trusted-host needs [http[s]://]HOST[:PORT].";
        let (https, default_port, authority) = match input.split_once("://") {
            Some(("https", authority)) => (true, Some(HTTPS_PORT), authority),
            Some(("http", authority)) => (false, Some(HTTP_PORT), authority),
            None => (false, None, input),
            Some(_) => return Err(INVALID),
        };
        let (host, port) = parse_authority(authority).ok_or(INVALID)?;
        let host = url::Host::parse(&host).map_err(|_| INVALID)?.to_string();
        Ok(Self {
            https,
            host,
            port: port.or(default_port),
        })
    }
}

fn parse_authority(input: &str) -> Option<(String, Option<u16>)> {
    let authority = input.parse::<Authority>().ok()?;
    let host = authority.host();
    if input.contains('@') || host.is_empty() {
        return None;
    }
    let port = if let Some(suffix) = input.strip_prefix(host).filter(|suffix| !suffix.is_empty()) {
        let port = suffix.strip_prefix(':')?;
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        Some(port.parse().ok()?)
    } else {
        None
    };
    Some((host.to_ascii_lowercase(), port))
}

struct AllowedOrigin {
    host: String,
    port: u16,
    default_port: u16,
    origin: String,
}

impl AllowedOrigin {
    fn new(host: String, https: bool, port: u16) -> Self {
        let (scheme, default_port) = if https {
            ("https", HTTPS_PORT)
        } else {
            ("http", HTTP_PORT)
        };
        let origin = if port == default_port {
            format!("{scheme}://{host}")
        } else {
            format!("{scheme}://{host}:{port}")
        };
        Self {
            host,
            port,
            default_port,
            origin,
        }
    }

    fn allows(&self, host: &str, port: Option<u16>) -> bool {
        host == self.host && port.unwrap_or(self.default_port) == self.port
    }
}

pub struct Origins(Vec<AllowedOrigin>);

impl Origins {
    pub fn new(addr: SocketAddr, trusted: Vec<TrustedHost>) -> Self {
        let port = addr.port();
        let mut origins: Vec<_> = ["localhost", "127.0.0.1", "[::1]"]
            .into_iter()
            .map(|host| AllowedOrigin::new(host.into(), false, port))
            .collect();
        if addr.ip().is_loopback() {
            origins.push(AllowedOrigin::new(host_literal(addr.ip()), false, port));
        }
        origins.extend(trusted.into_iter().map(|entry| {
            let port = entry.port.unwrap_or(port);
            AllowedOrigin::new(entry.host, entry.https, port)
        }));
        Self(origins)
    }

    /// Opens a local URL when the listener is reachable using an allowed HTTP authority.
    pub fn browser_url(&self, addr: SocketAddr) -> Option<&str> {
        let ip = match addr.ip() {
            IpAddr::V4(ip) if ip.is_unspecified() => Ipv4Addr::LOCALHOST.into(),
            IpAddr::V6(ip) if ip.is_unspecified() => std::net::Ipv6Addr::LOCALHOST.into(),
            ip => ip,
        };
        let host = host_literal(ip);
        self.0
            .iter()
            .find(|entry| {
                entry.allows(&host, Some(addr.port())) && entry.origin.starts_with("http://")
            })
            .map(|entry| entry.origin.as_str())
    }

    fn check(&self, request: &Request) -> Result<(), StatusCode> {
        let headers = request.headers();
        let (host, port) = unique_header(headers, header::HOST)
            .and_then(parse_authority)
            .ok_or(StatusCode::BAD_REQUEST)?;
        let mut matches = self
            .0
            .iter()
            .filter(|entry| entry.allows(&host, port))
            .peekable();
        if matches.peek().is_none() || request.uri().authority().is_some() {
            return Err(StatusCode::BAD_REQUEST);
        }

        let mutation = !request.method().is_safe();
        let origin = unique_header(headers, header::ORIGIN);
        if (mutation || headers.contains_key(header::ORIGIN))
            && !matches.any(|entry| origin == Some(entry.origin.as_str()))
        {
            return Err(StatusCode::FORBIDDEN);
        }

        if mutation
            && !unique_header(headers, header::CONTENT_TYPE)
                .and_then(|content_type| content_type.parse::<mime::Mime>().ok())
                .is_some_and(|content_type| content_type.essence_str() == "application/json")
        {
            return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
        }
        Ok(())
    }
}

fn host_literal(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    }
}

fn unique_header(headers: &HeaderMap, name: HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

#[derive(Clone)]
struct StateData {
    auth: Arc<Auth>,
    key_changes: watch::Receiver<()>,
}

pub fn router(auth: Auth, key_changes: watch::Receiver<()>, origins: Origins) -> Router {
    let state = StateData {
        auth: Arc::new(auth),
        key_changes,
    };
    let protected = Router::new()
        .route("/api/session", get(|| async { StatusCode::NO_CONTENT }))
        // Same-origin browser fetches omit Origin on GET, so subscriptions use JSON POST.
        .route(
            EVENTS,
            post(events).layer(DefaultBodyLimit::max(KEY_BODY_LIMIT)),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ));
    Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .route(
            "/api/login",
            post(login).layer(DefaultBodyLimit::max(KEY_BODY_LIMIT)),
        )
        .merge(protected)
        .layer(middleware::from_fn_with_state(
            Arc::new(origins),
            check_origin,
        ))
        .with_state(state)
}

async fn check_origin(
    State(origins): State<Arc<Origins>>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = match origins.check(&request) {
        Ok(()) => next.run(request).await,
        Err(status) => status.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'self'"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.remove(header::SET_COOKIE);
    response
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
    )
        .into_response()
}

async fn require_bearer(
    State(state): State<StateData>,
    mut request: Request,
    next: Next,
) -> Response {
    if let Some((scheme, token)) = unique_header(request.headers(), header::AUTHORIZATION)
        .and_then(|value| value.split_once(' '))
        && scheme.eq_ignore_ascii_case("Bearer")
        && let Some(session) = state.auth.authenticate(token).await
    {
        request.extensions_mut().insert(session);
        return next.run(request).await;
    }
    unauthorized()
}

#[derive(Deserialize)]
struct Login {
    access_key: String,
}

#[derive(Serialize)]
struct Credential {
    token: String,
    expires_in: u64,
}

async fn login(
    State(state): State<StateData>,
    payload: Result<Json<Login>, JsonRejection>,
) -> Response {
    let Json(Login { access_key }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return rejection.status().into_response(),
    };
    match state.auth.login(&access_key).await {
        Ok(Some(token)) => Json(Credential {
            token,
            expires_in: SESSION_LIFETIME.as_secs(),
        })
        .into_response(),
        Ok(None) => unauthorized(),
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn events(
    State(state): State<StateData>,
    Extension(session): Extension<Session>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Response {
    if let Err(rejection) = payload {
        return rejection.status().into_response();
    }
    let stream = stream::unfold(
        (state, None),
        move |(mut state, next_heartbeat)| async move {
            loop {
                if let Some(next_heartbeat) = next_heartbeat {
                    tokio::select! {
                        Ok(()) = state.key_changes.changed() => {}
                        _ = tokio::time::sleep(WATCH_FALLBACK) => {}
                        _ = tokio::time::sleep_until(next_heartbeat) => {}
                        _ = tokio::time::sleep_until(session.expires) => return None,
                    }
                }
                if !state.auth.is_live(session).await {
                    return None;
                }
                let now = tokio::time::Instant::now();
                if next_heartbeat.is_none_or(|deadline| now >= deadline) {
                    let comment = if next_heartbeat.is_none() {
                        "connected"
                    } else {
                        "keep-alive"
                    };
                    return Some((
                        Ok::<_, Infallible>(Event::default().comment(comment)),
                        (state, Some(now + HEARTBEAT)),
                    ));
                }
            }
        },
    );
    Sse::new(stream).into_response()
}
