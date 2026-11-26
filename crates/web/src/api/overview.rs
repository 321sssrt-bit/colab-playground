use axum::{
    Json,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{Response, sse::Event},
};
use colab_playground_core::{
    ErrorKind,
    accounts::{AccountId, AccountsView},
    backend::{AccountUsageView, InstallMethod},
    clock::unix_secs,
    host::{Line, ProbeReport},
    sessions::HardwareRate,
};
use colab_playground_shared::i18n::keys;
use colab_playground_web::state::{
    CliInstallEvent, CliInstallEvents, CliInstallPhase, CliInstallSnapshot, CliInstallStart,
    Snapshot,
};
use futures_util::stream;
use serde::{Deserialize, Serialize, de::IgnoredAny};

use super::{ApiError, ErrorMessage};
use crate::{
    auth::Session,
    http::{StateData, authenticated_events},
    i18n, platform,
};

#[derive(Serialize)]
pub(super) struct Overview {
    environment: ProbeReport,
    host: HostCheck,
    forward_policy: ForwardPolicyView,
    cli_installed: bool,
    helper_available: bool,
    keyring: KeyringCheck,
    accounts: Option<AccountsView>,
    accounts_error: Option<ErrorKind>,
    usage: Vec<AccountUsageView>,
    measured_rates: Vec<HardwareRate>,
    sampled_at: u64,
    unmanaged_runtimes: UnmanagedRuntimes,
    install_methods: Vec<InstallMethod>,
    cli_install: CliInstallView,
}

#[derive(Serialize)]
struct ForwardPolicyView {
    all_interfaces_allowed: bool,
    restriction: Option<&'static str>,
}

#[derive(Serialize)]
struct HostCheck {
    kind: &'static str,
    ready: bool,
    hint_key: Option<&'static str>,
    wsl_distro: Option<String>,
}

impl HostCheck {
    fn from_probe(
        environment: &ProbeReport,
        uses_wsl: bool,
        configured_distro: Option<String>,
    ) -> Self {
        if uses_wsl {
            let ready = environment.wsl_installed && !environment.wsl_distros.is_empty();
            let wsl_distro = configured_distro.or_else(|| environment.wsl_distros.first().cloned());
            Self {
                kind: "wsl",
                ready,
                hint_key: None,
                wsl_distro,
            }
        } else {
            let ready = environment.bash.is_some();
            Self {
                kind: "shell_tools",
                ready,
                hint_key: (ready && environment.ssh.is_none()).then_some(keys::STEP_SHELL_NO_SSH),
                wsl_distro: None,
            }
        }
    }
}

#[derive(Serialize)]
struct KeyringCheck {
    status: &'static str,
    hint_key: Option<&'static str>,
}

#[derive(Serialize)]
struct UnmanagedRuntimes {
    count: Option<usize>,
    incomplete: bool,
    unverified_accounts: Vec<AccountId>,
    warning_key: Option<&'static str>,
}

impl UnmanagedRuntimes {
    fn summarize(snapshot: &Snapshot, can_list: bool) -> Self {
        let runtimes = snapshot.runtimes.as_ref();
        let incomplete = snapshot.runtimes_error.is_some()
            || runtimes.is_none_or(|view| !view.errors.is_empty());
        let count = if can_list && !incomplete {
            runtimes.map(|view| {
                view.runtimes
                    .iter()
                    .filter(|runtime| !runtime.managed)
                    .count()
            })
        } else {
            None
        };
        let unverified_accounts = if !can_list {
            Vec::new()
        } else if snapshot.runtimes_error.is_some() || runtimes.is_none() {
            snapshot
                .accounts
                .iter()
                .flat_map(|view| view.accounts.iter())
                .map(|account| account.id.clone())
                .collect()
        } else {
            runtimes
                .iter()
                .flat_map(|view| view.errors.iter())
                .map(|failure| failure.account.clone())
                .collect()
        };
        let warning_key = match count {
            Some(1) => Some(keys::QUIT_UNWATCHED_ONE),
            Some(count) if count > 1 => Some(keys::QUIT_UNWATCHED_MANY),
            None if can_list => Some(i18n::UNMANAGED_UNKNOWN),
            _ => None,
        };
        Self {
            count,
            incomplete: can_list && incomplete,
            unverified_accounts,
            warning_key,
        }
    }
}

#[derive(Serialize)]
pub(super) struct CliInstallView {
    id: Option<u64>,
    method: Option<InstallMethod>,
    phase: CliInstallPhase,
    cli_installed: bool,
    cancelling: bool,
    lines: Vec<Line>,
    warning_title_key: Option<&'static str>,
    warning_body_key: Option<&'static str>,
    error: Option<serde_json::Value>,
}

impl From<CliInstallSnapshot> for CliInstallView {
    fn from(snapshot: CliInstallSnapshot) -> Self {
        let not_found = snapshot.phase == CliInstallPhase::NotFound;
        let error = snapshot.error.as_ref().map(|error| {
            serde_json::to_value(ErrorMessage::from(error)).expect("error serializes")
        });
        Self {
            id: snapshot.id,
            method: snapshot.method,
            phase: snapshot.phase,
            cli_installed: snapshot.phase == CliInstallPhase::Succeeded,
            cancelling: snapshot.cancelling,
            lines: snapshot.lines,
            warning_title_key: not_found.then_some(keys::INSTALL_NOT_FOUND_TITLE),
            warning_body_key: not_found.then_some(keys::INSTALL_NOT_FOUND_BODY),
            error,
        }
    }
}

pub(super) async fn get(State(state): State<StateData>) -> Result<Json<Overview>, ApiError> {
    let settings = state.settings.clone();
    let (environment, snapshot, cli_install_snapshot, now, configured_distro) = state
        .web
        .probe_environment_with(move || settings.current().wsl_distro)
        .await?;
    let host = HostCheck::from_probe(&environment, platform::uses_wsl(), configured_distro);
    let cli_installed = environment.colab.is_some();
    let helper_available = environment.helper_python.is_some();
    let keyring = if snapshot.accounts_error == Some(ErrorKind::KeyringUnavailable)
        || (helper_available && !environment.keyring_ok)
    {
        KeyringCheck {
            status: "unavailable",
            hint_key: Some(if platform::headless_secret_service() {
                i18n::HEADLESS_KEYRING
            } else {
                keys::NS_UNLOCK_KEYRING
            }),
        }
    } else if cli_installed && snapshot.accounts_error.is_none() && snapshot.accounts.is_some() {
        KeyringCheck {
            status: "ready",
            hint_key: None,
        }
    } else {
        KeyringCheck {
            status: "unknown",
            hint_key: None,
        }
    };
    let can_list =
        cli_installed && snapshot.accounts.is_some() && snapshot.accounts_error.is_none();
    let unmanaged_runtimes = UnmanagedRuntimes::summarize(&snapshot, can_list);
    let mut install_methods = vec![if environment.uv.is_some() {
        InstallMethod::Uv
    } else {
        InstallMethod::InstallUvThenCli
    }];
    if environment.python3.is_some() {
        install_methods.push(InstallMethod::PipUser);
    }
    let policy = state.web.forward_policy();
    let forward_policy = ForwardPolicyView {
        all_interfaces_allowed: policy.all_interfaces_allowed(),
        restriction: policy.all_interfaces_restriction(),
    };
    let cli_install = CliInstallView::from(cli_install_snapshot);
    Ok(Json(Overview {
        environment,
        host,
        forward_policy,
        cli_installed,
        helper_available,
        keyring,
        accounts: snapshot.accounts.clone(),
        accounts_error: snapshot.accounts_error,
        usage: if can_list {
            snapshot.usage.clone()
        } else {
            Vec::new()
        },
        measured_rates: snapshot.measured_rates.clone(),
        sampled_at: unix_secs(now),
        unmanaged_runtimes,
        install_methods,
        cli_install,
    }))
}

pub(super) async fn install_status(State(state): State<StateData>) -> Json<CliInstallView> {
    Json(CliInstallView::from(state.web.cli_install_snapshot()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Install {
    method: InstallMethod,
}

fn install_not_running() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "install_not_running",
        i18n::INSTALL_NOT_RUNNING,
    )
}

fn stream_cli_install(state: StateData, session: Session, events: CliInstallEvents) -> Response {
    #[derive(Serialize)]
    struct Started {
        id: u64,
        method: InstallMethod,
    }
    #[derive(Serialize)]
    struct Finished<'a> {
        status: &'static str,
        phase: CliInstallPhase,
        cli_installed: bool,
        warning_title_key: Option<&'static str>,
        warning_body_key: Option<&'static str>,
        error: Option<ErrorMessage<'a>>,
    }

    let sse = stream::unfold(events, |mut events| async move {
        let event = match events.next().await? {
            CliInstallEvent::Started { id, method } => Event::default()
                .event("started")
                .json_data(Started { id, method }),
            CliInstallEvent::Line(line) => Event::default().event("line").json_data(line),
            CliInstallEvent::Finished(outcome) => {
                let not_found = outcome.phase == CliInstallPhase::NotFound;
                let error = if not_found {
                    // Legacy SSE clients only understand `succeeded | cancelled | failed`; emit
                    // the localized not-found warning so they neither show "installed" nor drop
                    // the frame before UI #87 switches to `phase === "not_found"`.
                    Some(ErrorMessage::localized(
                        ErrorKind::NotInstalled.as_str(),
                        keys::INSTALL_NOT_FOUND_TITLE,
                        Some(keys::INSTALL_NOT_FOUND_BODY),
                    ))
                } else {
                    outcome.error.as_ref().map(ErrorMessage::from)
                };
                Event::default().event("finished").json_data(Finished {
                    status: outcome.phase.wire_status(),
                    phase: outcome.phase,
                    cli_installed: outcome.cli_installed,
                    warning_title_key: not_found.then_some(keys::INSTALL_NOT_FOUND_TITLE),
                    warning_body_key: not_found.then_some(keys::INSTALL_NOT_FOUND_BODY),
                    error,
                })
            }
        };
        Some((event, events))
    });
    authenticated_events(state, session, sse)
}

pub(super) async fn install(
    State(state): State<StateData>,
    Extension(session): Extension<Session>,
    payload: Result<Json<Install>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(install) = payload?;
    let events = match state.web.start_cli_install(install.method)? {
        CliInstallStart::Started { events, .. } => events,
        CliInstallStart::AlreadyRunning { id } => return Err(ApiError::busy(id)),
    };
    Ok(stream_cli_install(state, session, events))
}

pub(super) async fn install_events_latest(
    State(state): State<StateData>,
    Extension(session): Extension<Session>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<Response, ApiError> {
    let _ = payload?;
    let events = state
        .web
        .subscribe_cli_install(None)
        .ok_or_else(install_not_running)?;
    Ok(stream_cli_install(state, session, events))
}

pub(super) async fn install_events(
    State(state): State<StateData>,
    Path(id): Path<String>,
    Extension(session): Extension<Session>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<Response, ApiError> {
    let _ = payload?;
    let id = id.parse::<u64>().map_err(|_| ApiError::invalid_request())?;
    let events = state
        .web
        .subscribe_cli_install(Some(id))
        .ok_or_else(install_not_running)?;
    Ok(stream_cli_install(state, session, events))
}

pub(super) async fn cancel_install(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let _ = payload?;
    let id = id.parse::<u64>().map_err(|_| ApiError::invalid_request())?;
    if state.web.cancel_cli_install(id) {
        Ok(StatusCode::ACCEPTED)
    } else {
        Err(install_not_running())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_without_ssh_keeps_the_host_ready_and_explains_the_forward_limit() {
        let report = ProbeReport {
            bash: Some("/bin/bash".into()),
            ..ProbeReport::default()
        };
        let host = HostCheck::from_probe(&report, false, None);
        assert!(host.ready);
        assert_eq!(host.hint_key, Some(keys::STEP_SHELL_NO_SSH));
        assert!(host.wsl_distro.is_none());
    }

    #[test]
    fn wsl_host_prefers_configured_distro_over_detected_first() {
        let report = ProbeReport {
            wsl_installed: true,
            wsl_distros: vec!["Ubuntu".into(), "Debian".into()],
            ..ProbeReport::default()
        };
        let configured = HostCheck::from_probe(&report, true, Some("Debian".into()));
        assert!(configured.ready);
        assert_eq!(configured.wsl_distro.as_deref(), Some("Debian"));

        let fallback = HostCheck::from_probe(&report, true, None);
        assert_eq!(fallback.wsl_distro.as_deref(), Some("Ubuntu"));
    }
}
