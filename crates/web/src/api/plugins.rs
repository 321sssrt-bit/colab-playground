use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{Response, sse::Event},
    routing::{delete, get, post},
};
use colab_playground_core::{
    Error, ErrorKind,
    backend::{PluginRunSpec, RuntimeRef},
    hf::HfModel,
    plugins::{Capability, Manifest, PluginInfo, PluginOrigin},
    quant::{FitChoice, FitInput, GgufListing, QUANT_AUTO, fit_auto, fit_fixed},
};
use colab_playground_shared::i18n::keys;
use colab_playground_web::state::{Access, AccountContext, plugins::RunEvent};
use futures_util::stream;
use serde::{Deserialize, Serialize, de::IgnoredAny};
use serde_json::json;

use super::{ApiError, ErrorMessage, finish};
use crate::{
    auth::Session,
    http::{RequestHost, StateData, authenticated_events},
};

const HF_RESULTS: u32 = 8;

pub(super) fn routes() -> Router<StateData> {
    Router::new()
        .route("/api/plugins", get(list))
        .route("/api/plugins/previews", post(preview))
        .route("/api/plugins/previews/{id}", post(install).delete(discard))
        .route("/api/plugins/{id}", delete(remove).patch(enable))
        .route("/api/plugins/{id}/template", get(template))
        .route(
            "/api/plugins/hf/token",
            get(token).put(save_token).delete(delete_token),
        )
        .route("/api/plugins/hf/search", post(search))
        .route("/api/plugins/hf/gguf", post(gguf))
        .route("/api/plugins/runs", get(runs).post(run))
        .route("/api/plugins/runs/{id}/events", post(events))
        .route("/api/plugins/runs/{id}/cancel", post(cancel))
}

async fn list(State(state): State<StateData>) -> Result<Json<Vec<PluginInfo>>, ApiError> {
    Ok(Json(
        state
            .web
            .run_backend(|backend, _| Ok(backend.plugins()))
            .await?,
    ))
}

async fn template(
    State(state): State<StateData>,
    Path(id): Path<String>,
) -> Result<Json<PluginRunSpec>, ApiError> {
    Ok(Json(
        state
            .web
            .run_backend(move |backend, _| backend.plugin_run_template(&id))
            .await?,
    ))
}

#[derive(Serialize)]
struct Preview {
    preview_id: String,
    manifest: Manifest,
    script_bytes: u64,
    replaces_version: Option<String>,
    warning_key: &'static str,
}

async fn preview(
    State(state): State<StateData>,
    payload: Result<Json<PluginOrigin>, JsonRejection>,
) -> Result<(StatusCode, Json<Preview>), ApiError> {
    let Json(origin) = payload?;
    let staged = state.web.preview_plugin(origin).await?;
    Ok((
        StatusCode::CREATED,
        Json(Preview {
            preview_id: staged.id,
            manifest: staged.manifest,
            script_bytes: staged.script_bytes,
            replaces_version: staged.replaces_version,
            warning_key: keys::PLUGIN_RUNS_ON_RUNTIME,
        }),
    ))
}

async fn install(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<(StatusCode, Json<PluginInfo>), ApiError> {
    let _ = payload?;
    let installed = finish(state.web.install_plugin(id)?).await?;
    Ok((StatusCode::CREATED, Json(installed)))
}

async fn discard(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let _ = payload?;
    state.web.discard_plugin_preview(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enabled {
    enabled: bool,
}

async fn enable(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<Enabled>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(payload) = payload?;
    finish(state.web.start_operation(
        "set_plugin_enabled",
        id.clone(),
        Access::HostWrite,
        move |backend, cancel| {
            cancel.commit()?;
            backend.set_plugin_enabled(&id, payload.enabled)
        },
    )?)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let _ = payload?;
    finish(state.web.remove_plugin(id)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct TokenStatus {
    saved: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    token: String,
}

async fn token(State(state): State<StateData>) -> Result<Json<TokenStatus>, ApiError> {
    let saved = state
        .web
        .run_backend(|backend, cancel| {
            backend
                .has_secret(Capability::HfToken.secret_name(), cancel)
                .map_err(|error| Error::new(error.kind))
        })
        .await?;
    Ok(Json(TokenStatus { saved }))
}

async fn save_token(
    State(state): State<StateData>,
    payload: Result<Json<Token>, JsonRejection>,
) -> Result<Json<TokenStatus>, ApiError> {
    let Json(payload) = payload?;
    if payload.token.trim().is_empty() {
        return Err(Error::invalid("token", "empty token").into());
    }
    finish(state.web.start_operation(
        "hf_token",
        String::new(),
        Access::Independent,
        move |backend, cancel| {
            cancel.commit()?;
            backend
                .set_secret(
                    Capability::HfToken.secret_name(),
                    payload.token.trim(),
                    cancel,
                )
                .map_err(|error| Error::new(error.kind))
        },
    )?)
    .await?;
    Ok(Json(TokenStatus { saved: true }))
}

async fn delete_token(
    State(state): State<StateData>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<Json<TokenStatus>, ApiError> {
    let _ = payload?;
    finish(state.web.start_operation(
        "hf_token",
        String::new(),
        Access::Independent,
        |backend, cancel| {
            cancel.commit()?;
            backend
                .delete_secret(Capability::HfToken.secret_name(), cancel)
                .map_err(|error| Error::new(error.kind))
        },
    )?)
    .await?;
    Ok(Json(TokenStatus { saved: false }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: String,
}

async fn search(
    State(state): State<StateData>,
    payload: Result<Json<Search>, JsonRejection>,
) -> Result<Json<Vec<HfModel>>, ApiError> {
    let Json(payload) = payload?;
    Ok(Json(
        state
            .web
            .run_backend(move |backend, cancel| {
                backend.hf_search(payload.query.trim(), HF_RESULTS, cancel)
            })
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Gguf {
    repo: String,
    fit: Option<FitInput>,
    quant: Option<String>,
}

#[derive(Serialize)]
struct GgufResult<'a> {
    listing: GgufListing,
    fit: Option<FitChoice>,
    fit_error: Option<ErrorMessage<'a>>,
}

async fn gguf(
    State(state): State<StateData>,
    payload: Result<Json<Gguf>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(payload) = payload?;
    let listing = state
        .web
        .run_backend(move |backend, cancel| backend.hf_files(payload.repo.trim(), cancel))
        .await?;
    let fit = payload
        .fit
        .as_ref()
        .map(|input| match payload.quant.as_deref() {
            None | Some(QUANT_AUTO) => fit_auto(&listing, input),
            Some(quant) => fit_fixed(&listing, quant, input),
        });
    let (fit, error) = match fit {
        Some(Ok(choice)) => (Some(choice), None),
        Some(Err(error)) => (None, Some(error)),
        None => (None, None),
    };
    use axum::response::IntoResponse as _;
    Ok(Json(GgufResult {
        listing,
        fit,
        fit_error: error.as_ref().map(ErrorMessage::from),
    })
    .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    account_context: AccountContext,
    spec: PluginRunSpec,
    existing: Option<RuntimeRef>,
}

#[derive(Serialize)]
struct RunInfo {
    id: u64,
    finished: bool,
}

async fn runs(State(state): State<StateData>) -> Json<Vec<RunInfo>> {
    Json(
        state
            .web
            .plugin_runs()
            .into_iter()
            .map(|(id, finished)| RunInfo { id, finished })
            .collect(),
    )
}

async fn run(
    State(state): State<StateData>,
    payload: Result<Json<Run>, JsonRejection>,
) -> Result<(StatusCode, Json<RunInfo>), ApiError> {
    let Json(payload) = payload?;
    let id = state
        .web
        .start_plugin_run(payload.account_context, payload.spec, payload.existing)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(RunInfo {
            id,
            finished: false,
        }),
    ))
}

fn run_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "run_not_found", keys::RUN_NO_SESSION)
}

async fn cancel(
    State(state): State<StateData>,
    Path(id): Path<u64>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let _ = payload?;
    if state.web.cancel_plugin_run(id) {
        Ok(StatusCode::ACCEPTED)
    } else {
        Err(run_not_found())
    }
}

async fn events(
    State(state): State<StateData>,
    Path(id): Path<u64>,
    Extension(session): Extension<Session>,
    Extension(host): Extension<Arc<RequestHost>>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<Response, ApiError> {
    let _ = payload?;
    let run = state.web.plugin_run(id).ok_or_else(run_not_found)?;
    let stream = stream::unfold(
        (run.subscribe(), state.web.clone(), host),
        |(mut events, web, host)| async move {
            let event = match events.next().await? {
                RunEvent::Progress { kind, mut data } => {
                    if kind == "log_skipped" {
                        data["message_key"] = keys::RUN_LOG_SKIPPED.into();
                    }
                    Event::default().event(kind).json_data(data)
                }
                RunEvent::Finished {
                    outcome,
                    endpoints,
                    error,
                } => {
                    let snapshot = web.snapshot();
                    let endpoints: Vec<_> = endpoints.into_iter().map(|endpoint| {
                    let forward = endpoint.forward_id.and_then(|id| snapshot.tunnels.iter().find(|forward| forward.id == id))
                        .map(|info| super::forwards::ForwardView::new(info.clone(), &host, Some(&endpoint.endpoint)));
                    json!({ "endpoint": endpoint.endpoint, "error": endpoint.error, "forward": forward })
                }).collect();
                    let phase = match error {
                        None => "ready",
                        Some(ErrorKind::Cancelled) => "cancelled",
                        Some(_) => "failed",
                    };
                    let error = error.map(Error::new);
                    Event::default().event("finished").json_data(json!({
                        "phase": phase,
                        "outcome": outcome,
                        "endpoints": endpoints,
                        "error": error.as_ref().map(ErrorMessage::from),
                    }))
                }
            };
            Some((event, (events, web, host)))
        },
    );
    Ok(authenticated_events(state, session, stream))
}
