use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use colab_playground_core::{
    Error, ErrorKind,
    accounts::{Account, AccountId, AccountsView},
    backend::AccountUsageView,
};
use colab_playground_web::state::{
    AccountContext, AccountSwitchApproval, AccountSwitchPreview, CancelLoginOutcome, LoginPrompt,
    Snapshot, Submission, SubmitCancelOutcome, WebState,
};
use serde::{Deserialize, Serialize};

use super::{ApiError, ErrorMessage, finish};
use crate::http::StateData;

pub(super) fn routes() -> Router<StateData> {
    Router::new()
        .route("/api/accounts", get(list))
        .route("/api/accounts/usage/refresh", post(refresh))
        .route("/api/accounts/recovered/dismiss", post(dismiss_recovered))
        .route("/api/accounts/adopt", post(adopt))
        .route(
            "/api/accounts/login",
            post(begin_login).delete(cancel_active_login),
        )
        .route(
            "/api/accounts/login/{id}",
            post(submit_login).delete(cancel_login),
        )
        .route(
            "/api/accounts/{id}/switch",
            get(preview_switch).post(confirm_switch),
        )
        .route("/api/accounts/{id}", delete(remove))
}

#[derive(Serialize)]
struct Accounts {
    account_context: AccountContext,
    accounts: AccountsView,
    usage: Vec<AccountUsageView>,
    login_id: Option<u64>,
}

impl Accounts {
    fn from_snapshot(snapshot: Arc<Snapshot>) -> Result<Json<Self>, ApiError> {
        if let Some(error) = snapshot.accounts_error {
            return Err(Error::new(error).into());
        }
        let accounts = snapshot
            .accounts
            .clone()
            .ok_or(Error::new(ErrorKind::Busy))?;
        Ok(Json(Self {
            account_context: snapshot.account.clone(),
            accounts,
            usage: snapshot.usage.clone(),
            login_id: snapshot.login_id,
        }))
    }
}

async fn list(State(state): State<StateData>) -> Result<Json<Accounts>, ApiError> {
    Accounts::from_snapshot(state.web.accounts_snapshot())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

async fn refresh(
    State(state): State<StateData>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<Json<Accounts>, ApiError> {
    let Json(_) = payload?;
    Accounts::from_snapshot(state.web.refresh_accounts().await?)
}

async fn dismiss_recovered(
    State(state): State<StateData>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(_) = payload?;
    state.web.dismiss_recovered_pending_add();
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AccountAction {
    account_context: AccountContext,
}

async fn adopt(
    State(state): State<StateData>,
    payload: Result<Json<AccountAction>, JsonRejection>,
) -> Result<Json<Account>, ApiError> {
    let Json(action) = payload?;
    Ok(Json(
        finish(state.web.adopt_account(action.account_context)?).await?,
    ))
}

struct CancelBeginOnDrop {
    web: WebState,
    id: u64,
    armed: bool,
}

impl Drop for CancelBeginOnDrop {
    fn drop(&mut self) {
        // Dropping the HTTP future before returning 201 leaves nobody with the prompt id.
        if self.armed {
            self.web.abort_login_start(self.id);
        }
    }
}

async fn begin_login(
    State(state): State<StateData>,
    payload: Result<Json<AccountAction>, JsonRejection>,
) -> Result<(StatusCode, Json<LoginPrompt>), ApiError> {
    let Json(action) = payload?;
    let submission = state.web.begin_login(action.account_context)?;
    let mut guard = match &submission {
        Submission::Started { id, .. } => Some(CancelBeginOnDrop {
            web: state.web.clone(),
            id: *id,
            armed: true,
        }),
        Submission::AlreadyRunning { .. } => None,
    };
    let prompt = finish(submission).await?;
    if let Some(guard) = &mut guard {
        guard.armed = false;
    }
    Ok((StatusCode::CREATED, Json(prompt)))
}

#[derive(Deserialize)]
struct LoginCode {
    code: String,
}

async fn submit_login(
    State(state): State<StateData>,
    Path(id): Path<u64>,
    payload: Result<Json<LoginCode>, JsonRejection>,
) -> Result<Json<Account>, ApiError> {
    let Json(input) = payload?;
    let account = finish(state.web.submit_login(id, input.code)?).await?;
    Ok(Json(account.ok_or(Error::cancelled())?))
}

#[derive(Serialize)]
struct CancelLoginResponse<'a> {
    outcome: &'static str,
    account_context: AccountContext,
    accounts: AccountsView,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<Account>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorMessage<'a>>,
}

fn cancel_login_response(outcome: CancelLoginOutcome) -> Response {
    match outcome {
        CancelLoginOutcome::RolledBack => StatusCode::NO_CONTENT.into_response(),
        CancelLoginOutcome::SubmittingSettled(settled) => {
            let (outcome, account, error) = match &settled.outcome {
                SubmitCancelOutcome::Cancelled => ("cancelled", None, None),
                SubmitCancelOutcome::Completed(account) => {
                    ("completed", Some(account.clone()), None)
                }
                SubmitCancelOutcome::Failed(error) => {
                    ("failed", None, Some(ErrorMessage::from(error)))
                }
            };
            (
                StatusCode::OK,
                Json(CancelLoginResponse {
                    outcome,
                    account_context: settled.account_context,
                    accounts: settled.accounts,
                    account,
                    error,
                }),
            )
                .into_response()
        }
    }
}

async fn cancel_login(
    State(state): State<StateData>,
    Path(id): Path<u64>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(_) = payload?;
    let outcome = state.web.cancel_login_settled(Some(id)).await?;
    Ok(cancel_login_response(outcome))
}

async fn cancel_active_login(
    State(state): State<StateData>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(_) = payload?;
    let outcome = state.web.cancel_login_settled(None).await?;
    Ok(cancel_login_response(outcome))
}

async fn preview_switch(
    State(state): State<StateData>,
    Path(id): Path<String>,
) -> Result<Json<AccountSwitchPreview>, ApiError> {
    Ok(Json(state.web.preview_switch(AccountId::new(id)?).await?))
}

async fn confirm_switch(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<AccountSwitchApproval>, JsonRejection>,
) -> Result<Json<AccountsView>, ApiError> {
    let Json(approval) = payload?;
    if approval.target() != &AccountId::new(id)? {
        return Err(ApiError::invalid_request());
    }
    Ok(Json(finish(state.web.confirm_switch(approval)?).await?))
}

async fn remove(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<AccountAction>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(action) = payload?;
    finish(
        state
            .web
            .remove_account(action.account_context, AccountId::new(id)?)?,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
