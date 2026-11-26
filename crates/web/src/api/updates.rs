use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use colab_playground_core::{
    CancelToken, Error, ErrorKind, Result,
    backend::{Backend, BackendKind},
    http::{HttpClient, default_client},
    update::{self, Release, UpdateStatus, Version},
};
use colab_playground_shared::settings::Settings;
use colab_playground_web::state::WebState;
use serde::Serialize;
use tokio::sync::watch;

use super::{ApiError, ErrorMessage, WebSettings};
use crate::http::StateData;

/// How often an automatic check asks GitHub (matches desktop `state::updates`).
pub(crate) const UPDATE_INTERVAL: Duration = Duration::from_secs(24 * 3600);
// Avoids hammering GitHub on repeated Settings opens while offline, without marking the daily check done.
pub(crate) const UPDATE_RETRY_INTERVAL: Duration = Duration::from_secs(3600);

const VERSION: &str = env!("CARGO_PKG_VERSION");
const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UpdateRepository {
    owner: String,
    repo: String,
}

impl UpdateRepository {
    pub(crate) fn from_url(repository: &str) -> Option<Self> {
        update::repo_slug(repository).map(|(owner, repo)| Self { owner, repo })
    }

    pub(crate) fn default_web() -> Self {
        Self::from_url(REPOSITORY).expect("Web package uses a GitHub repository")
    }

    fn releases_url(&self) -> String {
        format!("https://github.com/{}/{}/releases", self.owner, self.repo)
    }

    fn release_page(&self, version: &str) -> String {
        update::release_page(&self.owner, &self.repo, version)
    }
}

#[derive(Clone, Debug, Default)]
enum UpdateCheck {
    #[default]
    Idle,
    UpToDate,
    Available(Release),
    Failed(Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FlightOutcome {
    Skipped,
    Checked,
}

type FlightReceiver = watch::Receiver<Option<Result<FlightOutcome>>>;

#[derive(Default)]
struct UpdateState {
    check: UpdateCheck,
    attempted_at: Option<u64>,
    // Shares an in-progress check across concurrent callers and survives client disconnects.
    in_flight: Option<FlightReceiver>,
}

struct ClearInFlight {
    state: Arc<Mutex<UpdateState>>,
    armed: bool,
}

impl Drop for ClearInFlight {
    fn drop(&mut self) {
        if self.armed {
            self.state.lock().expect("updates lock").in_flight = None;
        }
    }
}

#[derive(Clone)]
pub(crate) struct WebUpdates {
    repository: UpdateRepository,
    http: Arc<dyn HttpClient>,
    state: Arc<Mutex<UpdateState>>,
}

impl WebUpdates {
    pub(crate) fn new() -> Self {
        Self::with_config(UpdateRepository::default_web(), default_client())
    }

    pub(crate) fn with_config(repository: UpdateRepository, http: Arc<dyn HttpClient>) -> Self {
        Self {
            repository,
            http,
            state: Arc::new(Mutex::new(UpdateState::default())),
        }
    }

    async fn evaluate(
        &self,
        web: &WebState,
        settings: &WebSettings,
        manual: bool,
    ) -> std::result::Result<Response, ApiError> {
        loop {
            let mut rx = {
                let mut state = self.state.lock().expect("updates lock");
                if let Some(existing) = &state.in_flight {
                    existing.clone()
                } else {
                    let current_settings = settings.current();
                    if !manual && !current_settings.check_updates.0 {
                        return Ok(self.notice_response(&current_settings, &state));
                    }
                    let checked_at = current_settings.update_checked_at;
                    let attempted_at = state.attempted_at;
                    let (tx, rx) = watch::channel(None);
                    state.in_flight = Some(rx.clone());
                    let updates = self.clone();
                    let web = web.clone();
                    let settings = settings.clone();
                    tokio::spawn(async move {
                        let mut guard = ClearInFlight {
                            state: updates.state.clone(),
                            armed: true,
                        };
                        let outcome = updates
                            .run_flight(&web, &settings, manual, checked_at, attempted_at)
                            .await;
                        guard.armed = false;
                        let _ = tx.send(Some(outcome));
                    });
                    rx
                }
            };

            let outcome = match rx.wait_for(|done| done.is_some()).await {
                Ok(done) => done.as_ref().expect("wait_for guarantees Some").clone(),
                Err(_) => return Err(Error::new(ErrorKind::Other).into()),
            };
            match outcome? {
                FlightOutcome::Skipped if manual => continue,
                FlightOutcome::Skipped | FlightOutcome::Checked => {
                    let latest = settings.current();
                    let state = self.state.lock().expect("updates lock");
                    return Ok(self.notice_response(&latest, &state));
                }
            }
        }
    }

    async fn run_flight(
        &self,
        web: &WebState,
        settings: &WebSettings,
        manual: bool,
        checked_at: Option<u64>,
        attempted_at: Option<u64>,
    ) -> Result<FlightOutcome> {
        let repository = self.repository.clone();
        let http = self.http.clone();
        let execution = web
            .run_backend(move |backend, cancel| {
                let now = secs(backend.now());
                if !manual && !is_due(now, checked_at, attempted_at) {
                    return Ok(CheckExecution::Skipped);
                }
                let result = run_check(backend, &*http, &repository, cancel);
                if let Err(error) = &result
                    && error.is(ErrorKind::Cancelled)
                {
                    return Err(error.clone());
                }
                Ok(CheckExecution::Checked { result, now })
            })
            .await;

        let execution = match execution {
            Ok(execution) => execution,
            Err(error) => {
                self.state.lock().expect("updates lock").in_flight = None;
                return Err(error);
            }
        };

        match execution {
            CheckExecution::Skipped => {
                self.state.lock().expect("updates lock").in_flight = None;
                Ok(FlightOutcome::Skipped)
            }
            CheckExecution::Checked { result, now } => {
                match result {
                    Ok(UpdateStatus::UpToDate) => {
                        settings.update_metadata(|s| {
                            s.update_checked_at = Some(now);
                            if s.update_latest
                                .as_deref()
                                .is_some_and(|v| newer_version(v).is_none())
                            {
                                s.update_latest = None;
                            }
                        });
                        let mut state = self.state.lock().expect("updates lock");
                        state.attempted_at = Some(now);
                        state.check = UpdateCheck::UpToDate;
                        state.in_flight = None;
                    }
                    Ok(UpdateStatus::Available(release)) => {
                        let version = release.version.clone();
                        settings.update_metadata(|s| {
                            s.update_checked_at = Some(now);
                            s.update_latest = Some(version);
                        });
                        let mut state = self.state.lock().expect("updates lock");
                        state.attempted_at = Some(now);
                        state.check = UpdateCheck::Available(release);
                        state.in_flight = None;
                    }
                    Err(error) => {
                        // A failed check does not record `update_checked_at`, so a restart retries.
                        let mut state = self.state.lock().expect("updates lock");
                        state.attempted_at = Some(now);
                        state.check = UpdateCheck::Failed(error);
                        state.in_flight = None;
                    }
                }
                Ok(FlightOutcome::Checked)
            }
        }
    }

    fn notice_response(&self, settings: &Settings, state: &UpdateState) -> Response {
        let available = match &state.check {
            UpdateCheck::Available(release) => {
                Some((release.version.clone(), release.page.clone()))
            }
            _ => settings.update_latest.as_deref().and_then(|stored| {
                let version = newer_version(stored)?;
                let page = self.repository.release_page(&version);
                Some((version, page))
            }),
        };
        let status = match (&state.check, &available) {
            (_, Some(_)) => "available",
            (UpdateCheck::Failed(_), None) => "failed",
            (UpdateCheck::UpToDate, None) => "up_to_date",
            _ => "idle",
        };
        let error = match &state.check {
            UpdateCheck::Failed(error) => Some(ErrorMessage::from(error)),
            _ => None,
        };
        let (latest_version, release_url) = match available {
            Some((version, page)) => (Some(version), Some(page)),
            None => (None, None),
        };
        Json(UpdateNotice {
            current_version: VERSION,
            update_available: latest_version.is_some(),
            releases_url: self.repository.releases_url(),
            release_url,
            latest_version,
            status,
            checked_at: settings.update_checked_at,
            check_updates: settings.check_updates.0,
            error,
        })
        .into_response()
    }
}

enum CheckExecution {
    Skipped,
    Checked {
        result: Result<UpdateStatus>,
        now: u64,
    },
}

#[derive(Serialize)]
struct UpdateNotice<'a> {
    current_version: &'static str,
    update_available: bool,
    releases_url: String,
    release_url: Option<String>,
    latest_version: Option<String>,
    status: &'static str,
    checked_at: Option<u64>,
    check_updates: bool,
    error: Option<ErrorMessage<'a>>,
}

pub(super) async fn get(State(state): State<StateData>) -> std::result::Result<Response, ApiError> {
    state
        .updates
        .evaluate(&state.web, &state.settings, false)
        .await
}

pub(super) async fn check_now(
    State(state): State<StateData>,
) -> std::result::Result<Response, ApiError> {
    state
        .updates
        .evaluate(&state.web, &state.settings, true)
        .await
}

fn secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn newer_version(version: &str) -> Option<String> {
    let found = Version::parse(version)?;
    let current = Version::parse(VERSION)?;
    (found > current).then(|| found.to_string())
}

fn is_due(now: u64, checked_at: Option<u64>, attempted_at: Option<u64>) -> bool {
    let due_saved =
        checked_at.is_none_or(|last| now.saturating_sub(last) >= UPDATE_INTERVAL.as_secs());
    let due_retry =
        attempted_at.is_none_or(|last| now.saturating_sub(last) >= UPDATE_RETRY_INTERVAL.as_secs());
    due_saved && due_retry
}

fn run_check(
    backend: &dyn Backend,
    http: &dyn HttpClient,
    repository: &UpdateRepository,
    cancel: &CancelToken,
) -> Result<UpdateStatus> {
    match backend.kind() {
        BackendKind::Mock => backend.check_for_update(cancel).map(|status| match status {
            UpdateStatus::UpToDate => UpdateStatus::UpToDate,
            UpdateStatus::Available(release) => {
                // MockBackend formats its page against core's repository; rewrite to the Web fork.
                let page = repository.release_page(&release.version);
                UpdateStatus::Available(Release { page, ..release })
            }
        }),
        BackendKind::Real => {
            update::check(http, &repository.owner, &repository.repo, VERSION, cancel)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_slug_parsing_and_release_urls() {
        let default = UpdateRepository::default_web();
        assert_eq!(
            default.releases_url(),
            "https://github.com/321sssrt-bit/colab-playground/releases"
        );
        assert_eq!(
            default.release_page("0.6.0"),
            "https://github.com/321sssrt-bit/colab-playground/releases/tag/v0.6.0"
        );

        let custom = UpdateRepository::from_url("https://github.com/acme/fork.git/").unwrap();
        assert_eq!(
            custom.releases_url(),
            "https://github.com/acme/fork/releases"
        );
        assert_eq!(
            custom.release_page("1.2.3"),
            "https://github.com/acme/fork/releases/tag/v1.2.3"
        );
        assert!(UpdateRepository::from_url("https://gitlab.com/acme/fork").is_none());
    }

    #[test]
    fn throttle_and_version_comparison_boundaries() {
        let day = UPDATE_INTERVAL.as_secs();
        let hour = UPDATE_RETRY_INTERVAL.as_secs();
        assert!(is_due(1000, None, None));
        assert!(!is_due(1000 + day - 1, Some(1000), None));
        assert!(is_due(1000 + day, Some(1000), None));
        assert!(!is_due(1000 + hour - 1, None, Some(1000)));
        assert!(is_due(1000 + hour, None, Some(1000)));
        assert!(!is_due(u64::MAX, Some(u64::MAX), None));

        assert_eq!(newer_version("99.0.0").as_deref(), Some("99.0.0"));
        assert_eq!(
            newer_version("v99.0.0+../../evil").as_deref(),
            Some("99.0.0")
        );
        assert_eq!(newer_version(VERSION), None);
        assert_eq!(newer_version("0.0.1"), None);
        assert_eq!(newer_version("not-a-version"), None);
    }
}
