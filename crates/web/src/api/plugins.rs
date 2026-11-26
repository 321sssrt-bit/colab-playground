use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{Response, sse::Event},
    routing::{delete, get, post},
};
use colab_playground_core::{
    backend::{PluginRunSpec, RuntimeRef},
    hf::HfModel,
    plugins::{Capability, Manifest, PluginInfo, PluginOrigin},
    quant::{FitInput, KvType, QUANT_AUTO, fit_auto, fit_fixed, vram_choices_gib},
    sessions::Accelerator,
};
use colab_playground_shared::i18n::keys;
use colab_playground_web::state::{
    AccountContext, Submission,
    plugins::{RunEvent, RunPhase, RunSummary},
};
use futures_util::stream;
use serde::{Deserialize, Serialize, de::IgnoredAny};
use serde_json::json;

use super::{ApiError, ErrorMessage, finish};
use crate::{
    auth::Session,
    http::{RequestHost, StateData, authenticated_events},
    i18n,
};

const HF_RESULTS: u32 = 8;

pub(super) fn routes() -> Router<StateData> {
    Router::new()
        .route("/api/plugins", get(list))
        .route("/api/plugins/previews", post(preview))
        .route("/api/plugins/previews/cancel", post(cancel_preview))
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
    let staged = match state.web.start_plugin_preview(origin)? {
        Submission::Started { id, job } => state.web.finish_plugin_preview(id, job).await?,
        Submission::AlreadyRunning { id } => return Err(ApiError::busy(id)),
    };
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

async fn cancel_preview(
    State(state): State<StateData>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let _ = payload?;
    if state.web.cancel_plugin_preview() {
        Ok(StatusCode::ACCEPTED)
    } else {
        Ok(StatusCode::NO_CONTENT)
    }
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
    finish(state.web.enable_plugin(id, payload.enabled)?).await?;
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
            backend.has_secret(Capability::HfToken.secret_name(), cancel)
        })
        .await?;
    Ok(Json(TokenStatus { saved }))
}

async fn save_token(
    State(state): State<StateData>,
    payload: Result<Json<Token>, JsonRejection>,
) -> Result<Json<TokenStatus>, ApiError> {
    let Json(payload) = payload?;
    finish(state.web.save_hf_token(payload.token)?).await?;
    Ok(Json(TokenStatus { saved: true }))
}

async fn delete_token(
    State(state): State<StateData>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<Json<TokenStatus>, ApiError> {
    let _ = payload?;
    finish(state.web.delete_hf_token()?).await?;
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
    accelerator: Option<Accelerator>,
    #[serde(default)]
    fit: FitOptions,
    quant: Option<String>,
    #[serde(default)]
    refresh: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FitOptions {
    vram_mib: Option<u32>,
    ctx: u32,
    model_ctx: Option<u32>,
    kv_bytes_per_token: Option<u64>,
    mmproj_bytes: u64,
    kv: Option<KvType>,
}

async fn gguf(
    State(state): State<StateData>,
    payload: Result<Json<Gguf>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(payload) = payload?;
    let listing = state
        .web
        .hf_gguf_listing(payload.repo, payload.refresh)
        .await?;
    let sizes = match (payload.fit.vram_mib, payload.accelerator) {
        (Some(vram_mib), _) => vec![vram_mib],
        (None, Some(accelerator)) => vram_choices_gib(accelerator)
            .iter()
            .map(|size| size * 1024)
            .collect(),
        (None, None) => Vec::new(),
    };
    let fits: Vec<_> = sizes
        .into_iter()
        .map(|vram_mib| {
            let input = FitInput {
                vram_mib,
                ctx: payload.fit.ctx,
                model_ctx: payload.fit.model_ctx,
                kv_bytes_per_token: payload.fit.kv_bytes_per_token,
                mmproj_bytes: payload.fit.mmproj_bytes,
                kv: payload.fit.kv,
            };
            let estimate = match payload.quant.as_deref() {
                None | Some(QUANT_AUTO) => fit_auto(&listing, &input),
                Some(quant) => fit_fixed(&listing, quant, &input),
            };
            json!({
                "vram_mib": vram_mib,
                "fit": estimate.as_ref().ok(),
                "fit_error": estimate.as_ref().err().map(ErrorMessage::from),
            })
        })
        .collect();
    Ok(Json(json!({ "listing": listing, "fits": fits })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    account_context: AccountContext,
    spec: PluginRunSpec,
    existing: Option<RuntimeRef>,
}

async fn runs(State(state): State<StateData>) -> Json<Vec<RunSummary>> {
    Json(state.web.plugin_runs())
}

#[derive(Serialize)]
struct AcceptedRun {
    id: u64,
}

async fn run(
    State(state): State<StateData>,
    payload: Result<Json<Run>, JsonRejection>,
) -> Result<(StatusCode, Json<AcceptedRun>), ApiError> {
    let Json(payload) = payload?;
    let id = state
        .web
        .start_plugin_run(payload.account_context, payload.spec, payload.existing)
        .await?;
    Ok((StatusCode::ACCEPTED, Json(AcceptedRun { id })))
}

fn run_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "run_not_found",
        i18n::PLUGIN_RUN_NOT_FOUND,
    )
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
        (run.subscribe(), state.web.clone(), host, run),
        |(mut events, web, host, run)| async move {
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
                    json!({ "endpoint": endpoint.endpoint, "error": endpoint.error.as_ref().map(ErrorMessage::from), "forward": forward })
                }).collect();
                    let phase = RunPhase::from_error(error.as_ref());
                    Event::default().event("finished").json_data(json!({
                        "phase": phase,
                        "run": run.metadata(),
                        "outcome": outcome,
                        "endpoints": endpoints,
                        "error": error.as_ref().map(ErrorMessage::from),
                    }))
                }
            };
            Some((event, (events, web, host, run)))
        },
    );
    Ok(authenticated_events(state, session, stream))
}
