mod api;
mod auth;
mod cli;
mod http;
mod i18n;
mod platform;

use std::{
    env, future::IntoFuture as _, io, path::PathBuf, process::ExitCode, sync::Arc, time::Duration,
};

use colab_playground_core::{
    Error, ErrorKind, Host, InstanceLock,
    backend::Backend,
    mock::{MockBackend, MockConfig},
    paths::default_local_data_dir,
    real::{RealBackend, RealConfig},
};
use colab_playground_shared::{
    backend::{BACKEND_ENV, BackendSelection},
    errors,
    i18n::{Language, fill_lenient, template},
    settings::{CONFIG_DIR_ENV, Settings, SettingsStore, config_dir},
};

use colab_playground_web::state::WebState;

use crate::{
    api::WebSettings,
    auth::{Auth, KeyStore},
    cli::{Command, Serve},
    http::Origins,
};

fn data_dir(backend: &BackendSelection) -> io::Result<PathBuf> {
    match backend {
        BackendSelection::Mock(_) => config_dir(env::var_os(CONFIG_DIR_ENV)),
        BackendSelection::Real => default_local_data_dir(),
    }
    .ok_or_else(|| io::Error::other("No data directory is available for the selected backend."))
}

const MOCK_STEP_DELAY: Duration = Duration::from_millis(600);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(120);
const INTERRUPTED: u8 = 130;

fn build_backend(
    selection: BackendSelection,
    settings: Settings,
) -> colab_playground_core::Result<Arc<dyn Backend>> {
    match selection {
        BackendSelection::Mock(flags) => {
            let mut config = MockConfig::interactive(MOCK_STEP_DELAY);
            config.scenario = flags.scenario;
            config.failures = flags.failures;
            config.defaults = settings.defaults;
            Ok(Arc::new(MockBackend::new(config)))
        }
        BackendSelection::Real => {
            let host = settings.host_setup();
            let mut config = RealConfig::for_app(settings.defaults)?;
            if let Host::Wsl { distro } = &mut config.host {
                *distro = host.wsl_distro;
            }
            config.toolchain = host.toolchain;
            Ok(Arc::new(RealBackend::new(config)?))
        }
    }
}

async fn serve(options: Serve) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = data_dir(&options.backend)?;
    let _instance = InstanceLock::acquire(&data_dir)?;
    let listener = tokio::net::TcpListener::bind(options.bind).await?;
    let addr = listener.local_addr()?;
    let origins = Origins::new(addr, options.trusted_hosts);

    if !addr.ip().is_loopback() {
        eprintln!(
            "WARNING: Plain HTTP is listening on a non-loopback address. Web credentials travel \
             unencrypted. Use SSH local forwarding (ssh -L) or a TLS reverse proxy."
        );
    }

    let keys = KeyStore::new(&data_dir);
    keys.initialize()?;
    let (_key_watcher, key_changes) = keys.watch();
    let mut signals = platform::ShutdownSignals::install()?;
    let mode = match options.backend {
        BackendSelection::Mock(_) => "Demo data",
        BackendSelection::Real => "Real",
    };
    let (backend, settings) = tokio::task::spawn_blocking(move || {
        let settings =
            WebSettings::load(SettingsStore::new(config_dir(env::var_os(CONFIG_DIR_ENV))));
        let backend = build_backend(options.backend, settings.initial_settings())?;
        Ok::<_, Error>((backend, settings))
    })
    .await??;
    let state =
        WebState::start_with_forward_policy(backend, platform::forward_policy(addr)).await?;
    eprintln!("Web Server listening on {addr} ({mode})");
    if !options.no_open
        && let Some(url) = origins.browser_url(addr)
    {
        platform::open_browser(url);
    }

    let mut snapshots = state.subscribe();
    let server = axum::serve(
        listener,
        http::router(
            Auth::new(keys),
            key_changes,
            origins,
            state.clone(),
            settings,
        )
        .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = snapshots.wait_for(|snapshot| snapshot.shutting_down).await;
    })
    .into_future();
    tokio::pin!(server);
    let server_error = tokio::select! {
        result = &mut server => Some(result),
        () = signals.recv() => None,
    };

    let shutdown = state.shutdown(SHUTDOWN_GRACE);
    tokio::pin!(shutdown);
    let mut server_done = server_error.is_some();
    let report = loop {
        tokio::select! {
            biased;
            () = signals.recv() => platform::force_exit(INTERRUPTED),
            report = &mut shutdown => break report,
            _ = &mut server, if !server_done => server_done = true,
        }
    };
    let billing = report.billing;
    eprintln!(
        "Last known billing: {} managed ({} without an enforced watchdog), {} unmanaged \
         (no watchdog), status {}. Closed {} Forward(s).",
        billing.managed,
        billing.managed_without_watchdog,
        billing.unmanaged,
        if billing.unknown {
            "unknown or incomplete"
        } else {
            "known"
        },
        report.forwards_closed,
    );
    if !report.completed {
        eprintln!("Web Server shutdown cleanup did not complete.");
        platform::force_exit(1);
    }
    server_error.unwrap_or(Ok(()))?;
    Ok(())
}

fn command() -> Result<Command, &'static str> {
    let args = env::args_os()
        .skip(1)
        .map(|arg| {
            arg.into_string()
                .map_err(|_| "Arguments must be valid UTF-8.")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let backend = env::var(BACKEND_ENV);
    if matches!(backend, Err(env::VarError::NotUnicode(_))) {
        return Err("COLAB_PLAYGROUND_BACKEND must be mock or real.");
    }
    cli::parse(&args, backend.ok().as_deref())
}

#[tokio::main]
async fn main() -> ExitCode {
    let result = match command() {
        Ok(Command::Help) => {
            println!("{}", cli::usage());
            return ExitCode::SUCCESS;
        }
        Ok(Command::Rotate(backend)) => data_dir(&backend)
            .map_err(Into::into)
            .and_then(|dir| KeyStore::new(&dir).rotate()),
        Ok(Command::Serve(options)) => serve(options).await,
        Err(error) => {
            eprintln!("{error}\n{}", cli::usage());
            return ExitCode::from(2);
        }
    };
    if let Err(error) = result {
        if let Some(error) = error.downcast_ref::<Error>()
            && error.kind == ErrorKind::DataDirInUse
        {
            let message = errors::message(error, false);
            eprintln!(
                "{}",
                fill_lenient(template(Language::EnUs, message.key), &message.args)
            );
        } else {
            eprintln!("Web Server: {error}");
        }
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
