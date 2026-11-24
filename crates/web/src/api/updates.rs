use axum::{Json, extract::State};
use colab_playground_core::{
    CancelToken, Result,
    backend::{Backend, BackendKind},
    http::default_client,
    update::{self, UpdateStatus},
};
use serde::Serialize;

use super::ApiError;
use crate::http::StateData;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");

#[derive(Serialize)]
pub(super) struct UpdateNotice {
    current_version: &'static str,
    update_available: bool,
    releases_url: String,
}

pub(super) async fn get(State(state): State<StateData>) -> Result<Json<UpdateNotice>, ApiError> {
    Ok(Json(state.web.run_backend(check).await?))
}

fn check(backend: &dyn Backend, cancel: &CancelToken) -> Result<UpdateNotice> {
    let (owner, repo) =
        update::repo_slug(REPOSITORY).expect("Web package uses a GitHub repository");
    let status = match backend.kind() {
        BackendKind::Mock => backend.check_for_update(cancel)?,
        BackendKind::Real => update::check(&*default_client(), &owner, &repo, VERSION, cancel)?,
    };
    Ok(UpdateNotice {
        current_version: VERSION,
        update_available: matches!(status, UpdateStatus::Available(_)),
        releases_url: format!("{REPOSITORY}/releases"),
    })
}
