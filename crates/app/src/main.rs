#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};

use colab_playground::{
    app,
    backend::{BACKEND_ENV, BackendSource, source_from_args, usage},
    platform,
    settings::{CONFIG_DIR_ENV, SettingsStore, config_dir},
    state::StateOptions,
};
use colab_playground_core::{
    Error, ErrorKind, InstanceLock, paths::default_local_data_dir, updater::RESTART_ENV,
};
use colab_playground_shared::{
    errors,
    i18n::{fill_lenient, resolve, template},
    settings::LanguagePref,
};

const RESTART_LOCK_TIMEOUT: Duration = Duration::from_secs(60);
const RESTART_LOCK_RETRY: Duration = Duration::from_millis(100);

fn acquire_startup_lock(dir: &Path, wait: Duration) -> colab_playground_core::Result<InstanceLock> {
    let deadline = Instant::now() + wait;
    loop {
        let lock = InstanceLock::acquire(dir);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero()
            || !lock
                .as_ref()
                .is_err_and(|error| error.is(ErrorKind::DataDirInUse))
        {
            return lock;
        }
        thread::sleep(remaining.min(RESTART_LOCK_RETRY));
    }
}

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("warn,colab_playground=info"),
    )
    .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Every argument is checked before any backend exists: a typo never starts the real one.
    let source = match source_from_args(&args, std::env::var(BACKEND_ENV).ok().as_deref()) {
        Ok(source) => source,
        Err(error) => {
            log::error!("{error}");
            eprintln!("colab-playground: {error}\n{}", usage());
            std::process::exit(2);
        }
    };
    let store = SettingsStore::new(config_dir(std::env::var_os(CONFIG_DIR_ENV)));
    let os_locale = platform::os_locale();
    // The updater starts its replacement before the old process quits.
    let lock_wait = if std::env::var(RESTART_ENV).is_ok_and(|value| value == "1") {
        RESTART_LOCK_TIMEOUT
    } else {
        Duration::ZERO
    };
    let acquire = |dir: &Path| acquire_startup_lock(dir, lock_wait);
    let lock = match &source {
        BackendSource::Real => default_local_data_dir()
            .ok_or_else(|| Error::new(ErrorKind::Io).detail("no data directory"))
            .and_then(|dir| acquire(&dir))
            .map(Some),
        BackendSource::Mock(_) => store.dir().map(acquire).transpose(),
    };
    let _instance_lock = match lock {
        Ok(lock) => lock,
        Err(error) => {
            let language = resolve(LanguagePref::System, os_locale.as_deref());
            let message = errors::message(&error, false);
            let text = fill_lenient(template(language, message.key), &message.args);
            log::error!("{error}");
            eprintln!("colab-playground: {text}");
            std::process::exit(1);
        }
    };
    app::run(StateOptions {
        source,
        store,
        os_locale,
    });
}
