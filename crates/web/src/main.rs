mod auth;
mod cli;
mod http;
mod platform;

use std::{env, io, path::PathBuf, process::ExitCode};

use colab_playground_core::{Error, ErrorKind, InstanceLock, paths::default_local_data_dir};
use colab_playground_shared::{
    backend::{BACKEND_ENV, BackendSelection},
    errors,
    i18n::{Language, fill_lenient, template},
    settings::{CONFIG_DIR_ENV, config_dir},
};

use crate::{
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
    let mode = match options.backend {
        BackendSelection::Mock(_) => "Demo data",
        BackendSelection::Real => "Real",
    };
    eprintln!("Web Server listening on {addr} ({mode})");
    if !options.no_open
        && let Some(url) = origins.browser_url(addr)
    {
        platform::open_browser(url);
    }

    axum::serve(
        listener,
        http::router(Auth::new(keys), key_changes, origins),
    )
    .await?;
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
