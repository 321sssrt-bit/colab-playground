use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{Response, sse::Event},
    routing::{get, post},
};
use colab_playground_core::{
    Error, ErrorKind,
    backend::{Runtime, RuntimeRef, RuntimesView},
    clock::unix_secs,
    provision::{ProvisionEvent, ProvisionSpec},
};
use colab_playground_shared::i18n::keys;
use colab_playground_web::state::{
    AccountContext,
    sessions::{AutoStop, ProvisionUpdate},
};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ApiError, ErrorMessage, finish};
use crate::{
    auth::Session,
    http::{StateData, authenticated_events},
    i18n,
};

pub(super) fn routes() -> Router<StateData> {
    Router::new()
        .route("/api/sessions", get(list).post(create))
        .route("/api/sessions/template", get(template))
        .route("/api/sessions/{id}/events", post(events))
        .route("/api/sessions/{id}/cancel", post(cancel))
        .route("/api/sessions/stop", post(stop))
        .route("/api/sessions/auto-stop", post(auto_stop))
        .route("/api/sessions/stop-all", post(stop_all))
}

#[derive(Serialize)]
struct Sessions<'a> {
    account_context: &'a AccountContext,
    sampled_at: u64,
    runtimes: &'a [Runtime],
    errors: Vec<AccountFailure<'a>>,
    guard: Option<&'a colab_playground_core::backend::GuardReport>,
    guard_error: Option<ErrorKind>,
}

#[derive(Serialize)]
struct AccountFailure<'a> {
    account: &'a colab_playground_core::accounts::AccountId,
    error: ErrorMessage<'a>,
}

fn account_errors(
    view: &[colab_playground_core::backend::AccountError],
) -> Vec<AccountFailure<'_>> {
    view.iter()
        .map(|failure| AccountFailure {
            account: &failure.account,
            error: (&failure.error).into(),
        })
        .collect()
}

async fn list(State(state): State<StateData>) -> Result<Response, ApiError> {
    use axum::response::IntoResponse;

    let (snapshot, now) = state.web.list_runtimes().await?;
    let RuntimesView { runtimes, errors } = snapshot
        .runtimes
        .as_ref()
        .expect("runtime listing was published");
    Ok(Json(Sessions {
        account_context: &snapshot.account,
        sampled_at: unix_secs(now),
        runtimes,
        errors: account_errors(errors),
        guard: snapshot.guard.as_ref(),
        guard_error: snapshot.guard_error,
    })
    .into_response())
}

async fn template(State(state): State<StateData>) -> Result<Json<ProvisionSpec>, ApiError> {
    Ok(Json(
        state
            .web
            .run_backend(|backend, _| {
                let defaults = backend.defaults();
                let mut spec = defaults.provision_spec(backend.new_session_name(None));
                spec.high_mem &= spec.accelerator.supports_high_mem();
                spec.min_vram_mib = spec.min_vram_mib.filter(|_| spec.accelerator.is_gpu());
                Ok(spec)
            })
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    account_context: AccountContext,
    spec: ProvisionSpec,
}

#[derive(Serialize)]
struct Accepted {
    id: u64,
}

async fn create(
    State(state): State<StateData>,
    payload: Result<Json<Create>, JsonRejection>,
) -> Result<(StatusCode, Json<Accepted>), ApiError> {
    let Json(Create {
        account_context,
        spec,
    }) = payload?;
    if spec.high_mem && !spec.accelerator.supports_high_mem() {
        return Err(Error::invalid("high_mem", "accelerator has a fixed memory shape").into());
    }
    for duration in [spec.guard.max_runtime, spec.guard.idle_timeout]
        .into_iter()
        .flatten()
    {
        if duration.is_zero() {
            return Err(ApiError::invalid_request());
        }
        validate_seconds(duration)?;
    }
    validate_seconds(spec.retry_delay)?;
    if [spec.guard.max_spend_cu, spec.guard.min_balance_cu]
        .into_iter()
        .flatten()
        .any(|cu| !cu.is_finite() || cu < 0.0)
    {
        return Err(Error::invalid("guard", "compute units must be nonnegative").into());
    }
    let id = state.web.start_provision(account_context, spec)?;
    Ok((StatusCode::ACCEPTED, Json(Accepted { id })))
}

fn validate_seconds(duration: Duration) -> Result<(), ApiError> {
    // Leave room for elapsed time and the existing deadline when adding to a duration.
    u32::try_from(duration.as_secs()).map_err(|_| ApiError::invalid_request())?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

fn provision_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "provision_not_found",
        i18n::PROVISION_NOT_FOUND,
    )
}

async fn cancel(
    State(state): State<StateData>,
    Path(id): Path<u64>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let _ = payload?;
    if state.web.cancel_provision(id) {
        Ok(StatusCode::ACCEPTED)
    } else {
        Err(provision_not_found())
    }
}

async fn events(
    State(state): State<StateData>,
    Path(id): Path<u64>,
    Extension(session): Extension<Session>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<Response, ApiError> {
    let _ = payload?;
    let updates = state
        .web
        .provision_updates(id)
        .ok_or_else(provision_not_found)?;
    let events = stream::unfold(updates, |mut updates| async move {
        let event = match updates.next().await? {
            ProvisionUpdate::Progress(progress) => {
                let mut data = serde_json::to_value(&progress).expect("provision event serializes");
                match &progress {
                    ProvisionEvent::AllocationFailed { error, .. }
                    | ProvisionEvent::WatchdogFailed { error } => {
                        data["error"] = json!(ErrorMessage::from(error));
                    }
                    _ => {}
                }
                Event::default().event("progress").json_data(data)
            }
            ProvisionUpdate::Finished(result) => {
                let data = match result {
                    Ok(outcome) => json!({ "phase": "ready", "outcome": outcome }),
                    Err(error) => json!({
                        "phase": if error.is(ErrorKind::Cancelled) { "cancelled" } else { "failed" },
                        "error": ErrorMessage::from(&error),
                    }),
                };
                Event::default().event("finished").json_data(data)
            }
        };
        Some((event, updates))
    });
    Ok(authenticated_events(state, session, events))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Stop {
    target: RuntimeRef,
    confirmed: bool,
}

async fn stop(
    State(state): State<StateData>,
    payload: Result<Json<Stop>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(Stop { target, confirmed }) = payload?;
    if !confirmed {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "confirmation_required",
            keys::STOP_WIPED,
        ));
    }
    finish(state.web.stop_runtime(target)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AutoStopRequest {
    account_context: AccountContext,
    target: RuntimeRef,
    action: AutoStopAction,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum AutoStopAction {
    Extend { seconds: u32 },
    Set { seconds: u32 },
    Cancel,
}

async fn auto_stop(
    State(state): State<StateData>,
    payload: Result<Json<AutoStopRequest>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(request) = payload?;
    let action = match request.action {
        AutoStopAction::Extend { seconds: 0 } | AutoStopAction::Set { seconds: 0 } => {
            return Err(ApiError::invalid_request());
        }
        AutoStopAction::Extend { seconds } => AutoStop::Extend(Duration::from_secs(seconds.into())),
        AutoStopAction::Set { seconds } => AutoStop::Set(Duration::from_secs(seconds.into())),
        AutoStopAction::Cancel => AutoStop::Cancel,
    };
    let status = finish(state.web.change_auto_stop(
        request.account_context,
        request.target,
        action,
    )?)
    .await?;
    let armed = status
        .watchdog
        .as_ref()
        .and_then(|watchdog| watchdog.enforced_deadline())
        .is_some();
    Ok(Json(json!({
        "app_limit_seconds": status.runtime.map(|runtime| runtime.as_secs()),
        "watchdog_armed": armed,
        "watchdog": status.watchdog,
        "warning_key": (status.runtime.is_some() && !armed).then_some(keys::RUNTIME_AUTO_STOP_APP_ONLY),
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StopAll {
    confirmed: bool,
}

async fn stop_all(
    State(state): State<StateData>,
    payload: Result<Json<StopAll>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(StopAll { confirmed }) = payload?;
    if !confirmed {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "confirmation_required",
            keys::QUIT_STOP_WIPED,
        ));
    }
    let report = finish(state.web.stop_all_runtimes()?).await?;
    let remaining: Vec<_> = report
        .remaining
        .iter()
        .map(|runtime| {
            json!({
                "target": runtime.target,
                "error": runtime.stop_error.as_ref().map(ErrorMessage::from),
            })
        })
        .collect();
    Ok(Json(json!({
        "verified": remaining.is_empty() && report.account_errors.is_empty(),
        "remaining": remaining,
        "account_errors": account_errors(&report.account_errors),
    })))
}
