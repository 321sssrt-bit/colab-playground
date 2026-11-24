use std::sync::mpsc;

use axum::{
    Json,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{Response, sse::Event},
};
use colab_playground_core::{
    Error, ErrorKind,
    accounts::AccountsView,
    backend::{AccountUsageView, InstallMethod},
    host::{Line, ProbeReport},
};
use colab_playground_shared::i18n::keys;
use colab_playground_web::state::{Access, Operation, Submission};
use futures_util::{StreamExt as _, stream};
use serde::{Deserialize, Serialize, de::IgnoredAny};

use super::{ApiError, ErrorMessage};
use crate::{
    auth::Session,
    http::{StateData, authenticated_events},
    i18n, platform,
};

const INSTALL_CLI: &str = "install_cli";

#[derive(Serialize)]
pub(super) struct Overview {
    environment: ProbeReport,
    host: HostCheck,
    cli_installed: bool,
    helper_available: bool,
    keyring: KeyringCheck,
    accounts: Option<AccountsView>,
    accounts_error: Option<ErrorKind>,
    usage: Vec<AccountUsageView>,
    unmanaged_runtimes: UnmanagedRuntimes,
    install_methods: Vec<InstallMethod>,
}

#[derive(Serialize)]
struct HostCheck {
    kind: &'static str,
    ready: bool,
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
    warning_key: Option<&'static str>,
}

pub(super) async fn get(State(state): State<StateData>) -> Result<Json<Overview>, ApiError> {
    let environment = state.web.probe_environment().await?;
    let snapshot = state.web.snapshot();
    let host = if platform::uses_wsl() {
        HostCheck {
            kind: "wsl",
            ready: environment.wsl_installed && !environment.wsl_distros.is_empty(),
        }
    } else {
        HostCheck {
            kind: "shell_tools",
            ready: environment.bash.is_some() && environment.ssh.is_some(),
        }
    };
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
    let runtimes = snapshot.runtimes.as_ref();
    let count = runtimes.map(|view| {
        view.runtimes
            .iter()
            .filter(|runtime| !runtime.managed)
            .count()
    });
    let incomplete =
        snapshot.runtimes_error.is_some() || runtimes.is_none_or(|view| !view.errors.is_empty());
    let warning_key = match count {
        Some(1) => Some(keys::QUIT_UNWATCHED_ONE),
        Some(count) if count > 1 => Some(keys::QUIT_UNWATCHED_MANY),
        _ if incomplete => Some(keys::SUMMARY_INCOMPLETE),
        _ => None,
    };
    let mut install_methods = vec![if environment.uv.is_some() {
        InstallMethod::Uv
    } else {
        InstallMethod::InstallUvThenCli
    }];
    if environment.python3.is_some() {
        install_methods.push(InstallMethod::PipUser);
    }
    Ok(Json(Overview {
        environment,
        host,
        cli_installed,
        helper_available,
        keyring,
        accounts: snapshot.accounts.clone(),
        accounts_error: snapshot.accounts_error,
        usage: snapshot.usage.clone(),
        unmanaged_runtimes: UnmanagedRuntimes {
            count,
            incomplete,
            warning_key,
        },
        install_methods,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Install {
    method: InstallMethod,
}

pub(super) async fn install(
    State(state): State<StateData>,
    Extension(session): Extension<Session>,
    payload: Result<Json<Install>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(install) = payload?;
    let (send, receive) = mpsc::channel::<Line>();
    let submission = state.web.start_operation(
        INSTALL_CLI,
        String::new(),
        Access::HostWrite,
        move |backend, cancel| backend.install_cli(install.method, send, cancel),
    )?;
    let (id, job) = match submission {
        Submission::Started { id, job } => (id, job),
        Submission::AlreadyRunning { id } => return Err(ApiError::busy(id)),
    };
    #[derive(Serialize)]
    struct Started {
        id: u64,
    }
    #[derive(Serialize)]
    struct Finished<'a> {
        status: &'static str,
        error: Option<ErrorMessage<'a>>,
    }
    let started =
        stream::once(async move { Event::default().event("started").json_data(Started { id }) });
    let lines = stream::unfold(receive, |receive| async move {
        // Core writes to a blocking channel, and reading one line at a time avoids a second queue.
        let (line, receive) = tokio::task::spawn_blocking(move || (receive.recv().ok(), receive))
            .await
            .ok()?;
        line.map(|line| (Event::default().event("line").json_data(line), receive))
    });
    let finished = stream::once(async move {
        let result = job
            .await
            .unwrap_or_else(|_| Err(Error::new(ErrorKind::Other)));
        let status = match &result {
            Ok(()) => "succeeded",
            Err(error) if error.is(ErrorKind::Cancelled) => "cancelled",
            Err(_) => "failed",
        };
        Event::default().event("finished").json_data(Finished {
            status,
            error: result.as_ref().err().map(ErrorMessage::from),
        })
    });
    Ok(authenticated_events(
        state,
        session,
        started.chain(lines).chain(finished),
    ))
}

pub(super) async fn cancel_install(
    State(state): State<StateData>,
    Path(id): Path<String>,
    payload: Result<Json<IgnoredAny>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let _ = payload?;
    let id = id.parse::<u64>().map_err(|_| ApiError::invalid_request())?;
    let installing = state.web.snapshot().operations.iter().any(|pending| {
        pending.id == id
            && matches!(
                pending.operation,
                Operation::Domain {
                    name: INSTALL_CLI,
                    ..
                }
            )
    });
    if installing && state.web.cancel(id) {
        Ok(StatusCode::ACCEPTED)
    } else {
        Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "install_not_running",
            i18n::INSTALL_NOT_RUNNING,
        ))
    }
}
