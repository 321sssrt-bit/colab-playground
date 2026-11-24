mod accounts;
mod forwards;
mod overview;
mod plugins;
mod sessions;
mod settings;
mod updates;

use std::collections::BTreeMap;

use axum::{
    Json, Router,
    extract::{Path, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use colab_playground_core::{Error, ErrorKind};
use colab_playground_shared::errors;
use colab_playground_web::state::Submission;
use serde::Serialize;
use tokio::task::JoinError;

use crate::{http::StateData, i18n};

pub(crate) use settings::WebSettings;

pub(crate) fn routes() -> Router<StateData> {
    Router::new()
        .route("/api/forwards", get(forwards::list).post(forwards::open))
        .route("/api/forwards/{id}", delete(forwards::close))
        .route("/api/overview", get(overview::get))
        .route("/api/overview/cli/install", post(overview::install))
        .route(
            "/api/overview/cli/install/{id}/cancel",
            post(overview::cancel_install),
        )
        .route("/api/settings", get(settings::get).patch(settings::patch))
        .route("/api/updates", get(updates::get))
        .route("/api/i18n/{locale}", get(dictionary))
        .merge(accounts::routes())
        .merge(plugins::routes())
        .merge(sessions::routes())
}

async fn dictionary(Path(locale): Path<String>) -> Result<Json<i18n::Messages>, ApiError> {
    i18n::dictionary(&locale).map(Json).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "locale_not_found",
            i18n::LOCALE_NOT_FOUND,
        )
    })
}

#[derive(Serialize)]
struct ErrorMessage<'a> {
    kind: &'static str,
    message_key: &'static str,
    args: BTreeMap<&'a str, &'a str>,
    hint_key: Option<&'static str>,
    action_key: Option<&'static str>,
    operation_id: Option<u64>,
}

impl<'a> From<&'a Error> for ErrorMessage<'a> {
    fn from(error: &'a Error) -> Self {
        let message = errors::message(error, true);
        Self {
            kind: error.kind.as_str(),
            message_key: message.key,
            args: message.args.into_iter().collect(),
            hint_key: message.hint_key,
            action_key: message.action.map(|action| action.label_key()),
            operation_id: None,
        }
    }
}

pub(super) struct ApiError(Box<Response>);

impl ApiError {
    fn new(status: StatusCode, kind: &'static str, message_key: &'static str) -> Self {
        Self::with_message(
            status,
            ErrorMessage {
                kind,
                message_key,
                args: BTreeMap::new(),
                hint_key: None,
                action_key: None,
                operation_id: None,
            },
        )
    }

    fn with_message(status: StatusCode, error: ErrorMessage<'_>) -> Self {
        #[derive(Serialize)]
        struct Body<'a> {
            error: ErrorMessage<'a>,
        }

        Self(Box::new((status, Json(Body { error })).into_response()))
    }

    fn busy(id: u64) -> Self {
        let error = Error::new(ErrorKind::Busy);
        Self::with_message(
            StatusCode::CONFLICT,
            ErrorMessage {
                operation_id: Some(id),
                ..(&error).into()
            },
        )
    }

    fn invalid_request() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            i18n::INVALID_REQUEST,
        )
    }
}

impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        use ErrorKind as K;

        let status = match error.kind {
            K::InvalidInput if error.param("remove_active").is_some() => {
                return Self::new(
                    StatusCode::CONFLICT,
                    "active_account",
                    colab_playground_shared::i18n::keys::ACCOUNTS_REMOVE_ACTIVE,
                );
            }
            K::Busy if error.param("switch_impact_changed").is_some() => {
                return Self::new(
                    StatusCode::CONFLICT,
                    "switch_impact_changed",
                    i18n::SWITCH_IMPACT_CHANGED,
                );
            }
            K::LoginInvalidCode | K::InvalidInput | K::ManifestInvalid | K::PortReserved => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            K::Unsupported if error.param("forward_bind_restriction").is_some() => {
                let key = match error.param("forward_bind_restriction") {
                    Some("windows_or_wsl") => i18n::FORWARD_BIND_WINDOWS,
                    _ => i18n::FORWARD_BIND_LOOPBACK,
                };
                return Self::new(StatusCode::CONFLICT, "unsupported", key);
            }
            K::AuthRequired
            | K::LoginCancelled
            | K::PluginExists
            | K::PortInUse
            | K::SshBusy
            | K::Busy
            | K::Cancelled
            | K::AccountNotActive
            | K::NoActiveAccount
            | K::NotInstalled
            | K::KeyringUnavailable
            | K::AddInProgress => StatusCode::CONFLICT,
            K::AccountNotFound | K::SessionGone | K::PluginNotFound => StatusCode::NOT_FOUND,
            K::RateLimited | K::HttpUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            K::Http | K::GitFailed | K::LoginVerificationFailed => StatusCode::BAD_GATEWAY,
            K::Timeout => StatusCode::GATEWAY_TIMEOUT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self::with_message(status, (&error).into())
    }
}

impl From<JoinError> for ApiError {
    fn from(_: JoinError) -> Self {
        Error::new(ErrorKind::Other).into()
    }
}

impl From<JsonRejection> for ApiError {
    fn from(error: JsonRejection) -> Self {
        Self::new(error.status(), "invalid_request", i18n::INVALID_REQUEST)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        *self.0
    }
}

async fn finish<T>(submission: Submission<T>) -> Result<T, ApiError> {
    match submission {
        Submission::Started { job, .. } => Ok(job.await??),
        Submission::AlreadyRunning { id } => Err(ApiError::busy(id)),
    }
}
