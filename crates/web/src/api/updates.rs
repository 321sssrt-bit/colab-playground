use std::{
    fs,
    path::{Path, PathBuf},
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
    paths::write_atomic,
    update::{self, Release, UpdateStatus, Version},
};
use colab_playground_web::state::WebState;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::{ApiError, ErrorMessage, WebSettings};
use crate::http::StateData;

/// How often an automatic check asks GitHub (matches desktop `state::updates`).
pub(crate) const UPDATE_INTERVAL: Duration = Duration::from_secs(24 * 3600);
// Avoids hammering GitHub on repeated Settings opens while offline, without marking the daily check done.
pub(crate) const UPDATE_RETRY_INTERVAL: Duration = Duration::from_secs(3600);
pub(crate) const UPDATES_FILE: &str = "web-updates.json";

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

    fn canonical_url(&self) -> String {
        format!("https://github.com/{}/{}", self.owner, self.repo)
    }

    fn releases_url(&self) -> String {
        format!("{}/releases", self.canonical_url())
    }

    fn release_page(&self, version: &str) -> String {
        update::release_page(&self.owner, &self.repo, version)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct StoredUpdateCache {
    repository: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checked_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    latest_version: Option<String>,
}

impl StoredUpdateCache {
    fn load(file: &Path, expected_repo: &str) -> Self {
        let Ok(text) = fs::read_to_string(file) else {
            return Self::default();
        };
        let Ok(stored) = serde_json::from_str::<Self>(&text) else {
            return Self::default();
        };
        // Ignore cache entries written for a different repository so forks never cross-pollinate.
        if stored.repository != expected_repo {
            return Self::default();
        }
        stored
    }

    fn save(&self, file: &Path) -> Result<()> {
        let mut text = serde_json::to_string_pretty(self).expect("update cache serializes to JSON");
        text.push('\n');
        write_atomic(file, text.as_bytes())
            .map_err(|error| Error::new(ErrorKind::Io).detail(error.to_string()))
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
    checked_at: Option<u64>,
    latest_version: Option<String>,
    attempted_at: Option<u64>,
    persist_error: Option<Error>,
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
    cache_file: Option<PathBuf>,
    state: Arc<Mutex<UpdateState>>,
}

impl WebUpdates {
    pub(crate) fn load(config_dir: Option<PathBuf>) -> Self {
        Self::with_config(
            UpdateRepository::default_web(),
            default_client(),
            config_dir,
        )
    }

    pub(crate) fn with_config(
        repository: UpdateRepository,
        http: Arc<dyn HttpClient>,
        config_dir: Option<PathBuf>,
    ) -> Self {
        let cache_file = config_dir.map(|dir| dir.join(UPDATES_FILE));
        let stored = cache_file
            .as_deref()
            .map(|file| StoredUpdateCache::load(file, &repository.canonical_url()))
            .unwrap_or_default();
        Self {
            repository,
            http,
            cache_file,
            state: Arc::new(Mutex::new(UpdateState {
                checked_at: stored.checked_at,
                latest_version: stored.latest_version,
                ..UpdateState::default()
            })),
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
                    let check_updates = settings.current().check_updates.0;
                    if !manual && !check_updates {
                        return Ok(self.notice_response(check_updates, &state));
                    }
                    let checked_at = state.checked_at;
                    let attempted_at = state.attempted_at;
                    let (tx, rx) = watch::channel(None);
                    state.in_flight = Some(rx.clone());
                    let updates = self.clone();
                    let web = web.clone();
                    tokio::spawn(async move {
                        let mut guard = ClearInFlight {
                            state: updates.state.clone(),
                            armed: true,
                        };
                        let outcome = updates
                            .run_flight(&web, manual, checked_at, attempted_at)
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
                    let check_updates = settings.current().check_updates.0;
                    let state = self.state.lock().expect("updates lock");
                    return Ok(self.notice_response(check_updates, &state));
                }
            }
        }
    }

    async fn run_flight(
        &self,
        web: &WebState,
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
                        let next_latest = {
                            let state = self.state.lock().expect("updates lock");
                            state
                                .latest_version
                                .as_deref()
                                .and_then(newer_version)
                                .map(|_| state.latest_version.clone().unwrap())
                        };
                        let persist_error =
                            self.persist_cache(Some(now), next_latest.clone()).await;
                        let mut state = self.state.lock().expect("updates lock");
                        state.checked_at = Some(now);
                        state.latest_version = next_latest;
                        state.attempted_at = Some(now);
                        state.check = UpdateCheck::UpToDate;
                        state.persist_error = persist_error;
                        state.in_flight = None;
                    }
                    Ok(UpdateStatus::Available(release)) => {
                        let next_latest = Some(release.version.clone());
                        let persist_error =
                            self.persist_cache(Some(now), next_latest.clone()).await;
                        let mut state = self.state.lock().expect("updates lock");
                        state.checked_at = Some(now);
                        state.latest_version = next_latest;
                        state.attempted_at = Some(now);
                        state.check = UpdateCheck::Available(release);
                        state.persist_error = persist_error;
                        state.in_flight = None;
                    }
                    Err(error) => {
                        // A failed check does not record `checked_at`, so a restart retries.
                        let mut state = self.state.lock().expect("updates lock");
                        state.attempted_at = Some(now);
                        state.check = UpdateCheck::Failed(error);
                        state.persist_error = None;
                        state.in_flight = None;
                    }
                }
                Ok(FlightOutcome::Checked)
            }
        }
    }

    async fn persist_cache(
        &self,
        checked_at: Option<u64>,
        latest_version: Option<String>,
    ) -> Option<Error> {
        let file = self.cache_file.clone()?;
        let cache = StoredUpdateCache {
            repository: self.repository.canonical_url(),
            checked_at,
            latest_version,
        };
        match tokio::task::spawn_blocking(move || cache.save(&file)).await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(error) => Some(Error::new(ErrorKind::Io).detail(error.to_string())),
        }
    }

    fn notice_response(&self, check_updates: bool, state: &UpdateState) -> Response {
        let available = match &state.check {
            UpdateCheck::Available(release) => {
                Some((release.version.clone(), release.page.clone()))
            }
            _ => state.latest_version.as_deref().and_then(|stored| {
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
        let persist_error = state.persist_error.as_ref().map(ErrorMessage::from);
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
            checked_at: state.checked_at,
            check_updates,
            error,
            persist_error,
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
    persist_error: Option<ErrorMessage<'a>>,
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

    #[test]
    fn stored_cache_ignores_corrupt_or_mismatched_repository() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(UPDATES_FILE);
        let cache = StoredUpdateCache {
            repository: "https://github.com/321sssrt-bit/colab-playground".into(),
            checked_at: Some(12345),
            latest_version: Some("9.0.0".into()),
        };
        cache.save(&file).unwrap();

        assert_eq!(
            StoredUpdateCache::load(&file, "https://github.com/321sssrt-bit/colab-playground"),
            cache
        );
        assert_eq!(
            StoredUpdateCache::load(&file, "https://github.com/scarletkc/colab-playground"),
            StoredUpdateCache::default()
        );

        fs::write(&file, "{ not json").unwrap();
        assert_eq!(
            StoredUpdateCache::load(&file, "https://github.com/321sssrt-bit/colab-playground"),
            StoredUpdateCache::default()
        );
    }
}
