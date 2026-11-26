use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{
        ConnectInfo, DefaultBodyLimit, Extension, Path, Request, State, rejection::JsonRejection,
    },
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header, uri::Authority},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use colab_playground_web::{assets, state::WebState};
use futures_util::{Stream, StreamExt as _, stream};
use serde::{Deserialize, Serialize, de::IgnoredAny};
use tokio::sync::watch;

use crate::{
    api::{self, WebSettings, WebUpdates},
    auth::{Auth, SESSION_LIFETIME, Session},
    i18n,
};

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

pub(crate) struct RequestHost {
    pub(crate) name: String,
    pub(crate) direct_loopback: bool,
}

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

    fn check(&self, request: &Request) -> Result<RequestHost, StatusCode> {
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
        let direct_loopback = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .is_some_and(|ConnectInfo(peer)| peer.ip().to_canonical().is_loopback())
            && is_loopback_host(&host);
        Ok(RequestHost {
            name: host,
            direct_loopback,
        })
    }
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    match url::Host::parse(host) {
        Ok(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Ok(url::Host::Ipv6(ip)) => IpAddr::V6(ip).to_canonical().is_loopback(),
        Ok(url::Host::Domain(name)) => name.trim_end_matches('.') == "localhost",
        Err(_) => false,
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
pub(crate) struct StateData {
    auth: Arc<Auth>,
    key_changes: watch::Receiver<()>,
    pub(crate) web: WebState,
    pub(crate) settings: WebSettings,
    pub(crate) updates: WebUpdates,
}

pub fn router(
    auth: Auth,
    key_changes: watch::Receiver<()>,
    origins: Origins,
    web: WebState,
    settings: WebSettings,
) -> Router {
    let updates = WebUpdates::load(settings.config_dir());
    router_with_updates(auth, key_changes, origins, web, settings, updates)
}

pub(crate) fn router_with_updates(
    auth: Auth,
    key_changes: watch::Receiver<()>,
    origins: Origins,
    web: WebState,
    settings: WebSettings,
    updates: WebUpdates,
) -> Router {
    web.set_settings_notice(settings.notice());
    let state = StateData {
        auth: Arc::new(auth),
        key_changes,
        web,
        settings,
        updates,
    };
    let protected = Router::new()
        .route("/api/session", get(|| async { StatusCode::NO_CONTENT }))
        .route("/api/snapshot", get(snapshot))
        // Same-origin browser fetches omit Origin on GET, so subscriptions use JSON POST.
        .route(
            EVENTS,
            post(events).layer(DefaultBodyLimit::max(KEY_BODY_LIMIT)),
        )
        .merge(api::routes())
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ));
    Router::new()
        .route("/", get(index))
        .route("/favicon.ico", get(favicon))
        .route("/assets/i18n/{file}", get(public_dictionary))
        .route("/assets/{*path}", get(static_asset))
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

fn asset_response(asset: assets::Asset) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, asset.content_type),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        asset.body,
    )
        .into_response()
}

async fn index() -> Response {
    asset_response(assets::INDEX)
}

async fn favicon() -> Response {
    asset_response(assets::FAVICON)
}

async fn static_asset(Path(path): Path<String>) -> Response {
    match assets::lookup(&path) {
        Some(asset) => asset_response(asset),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn public_dictionary(Path(file): Path<String>) -> Response {
    let Some(locale) = file.strip_suffix(".json") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (Some(mut merged), Some(shell)) =
        (i18n::dictionary(locale), assets::shell_messages(locale))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    for &(key, value) in shell {
        merged.insert(key, value);
    }
    Json(merged).into_response()
}

async fn check_origin(
    State(origins): State<Arc<Origins>>,
    mut request: Request,
    next: Next,
) -> Response {
    let mut response = match origins.check(&request) {
        Ok(host) => {
            request.extensions_mut().insert(Arc::new(host));
            next.run(request).await
        }
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

async fn snapshot(State(state): State<StateData>) -> Response {
    Json(&*state.web.snapshot()).into_response()
}

async fn events(
    State(state): State<StateData>,
    Extension(session): Extension<Session>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Response {
    if let Err(rejection) = payload {
        return rejection.status().into_response();
    }
    let snapshots = stream::unfold(
        (state.web.subscribe(), true),
        |(mut snapshots, first)| async move {
            if !first {
                snapshots.changed().await.ok()?;
            }
            let snapshot = snapshots.borrow_and_update().clone();
            let event = Event::default()
                .event("snapshot")
                .id(snapshot.version.to_string())
                .json_data(&*snapshot);
            Some((event, (snapshots, false)))
        },
    );
    let forwards = stream::unfold(state.web.subscribe_forwards(), |mut forwards| async {
        loop {
            match forwards.recv().await {
                Ok(event) => {
                    return Some((Event::default().event("forward").json_data(event), forwards));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    authenticated_events(state, session, stream::select(snapshots, forwards))
}

pub(crate) fn authenticated_events(
    state: StateData,
    session: Session,
    events: impl Stream<Item = Result<Event, axum::Error>> + Send + 'static,
) -> Response {
    let shutdown = state.web.subscribe();
    let mut interval = tokio::time::interval(WATCH_FALLBACK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let stream = stream::unfold(
        (state, shutdown, Box::pin(events), interval),
        move |(mut state, mut shutdown, mut events, mut interval)| async move {
            loop {
                let event = tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(session.expires) => return None,
                    _ = shutdown.wait_for(|snapshot| snapshot.shutting_down) => return None,
                    Ok(()) = state.key_changes.changed() => None,
                    _ = interval.tick() => None,
                    event = events.next() => Some(event?),
                };
                if !state.auth.is_live(session).await || shutdown.borrow().shutting_down {
                    return None;
                }
                if let Some(event) = event {
                    return Some((event, (state, shutdown, events, interval)));
                }
            }
        },
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(HEARTBEAT).text("keep-alive"))
        .into_response()
}
