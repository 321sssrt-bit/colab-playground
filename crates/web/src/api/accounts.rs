use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::StatusCode,
    routing::{delete, get, post},
};
use colab_playground_core::{
    Error, ErrorKind,
    accounts::{Account, AccountId, AccountsView},
    backend::AccountUsageView,
};
use colab_playground_web::state::{AccountContext, AccountSwitchPreview, LoginPrompt, Snapshot};
use serde::{Deserialize, Serialize};

use super::{ApiError, finish};
use crate::http::StateData;

pub(super) fn routes() -> Router<StateData> {
    Router::new()
        .route("/api/accounts", get(list))
        .route("/api/accounts/usage/refresh", post(refresh))
        .route("/api/accounts/adopt", post(adopt))
        .route("/api/accounts/login", post(begin_login))
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

async fn begin_login(
    State(state): State<StateData>,
    payload: Result<Json<AccountAction>, JsonRejection>,
) -> Result<(StatusCode, Json<LoginPrompt>), ApiError> {
    let Json(action) = payload?;
    let prompt = finish(state.web.begin_login(action.account_context)?).await?;
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

async fn cancel_login(
    State(state): State<StateData>,
    Path(id): Path<u64>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(_) = payload?;
    finish(state.web.cancel_login(id)?).await?;
    Ok(StatusCode::NO_CONTENT)
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
    payload: Result<Json<AccountSwitchPreview>, JsonRejection>,
) -> Result<Json<AccountsView>, ApiError> {
    let Json(preview) = payload?;
    if preview.impact.to != AccountId::new(id)? {
        return Err(ApiError::invalid_request());
    }
    Ok(Json(finish(state.web.confirm_switch(preview)?).await?))
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
