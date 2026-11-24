#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use colab_playground::{
    app,
    backend::{BACKEND_ENV, BackendSource, source_from_args, usage},
    platform,
    settings::{CONFIG_DIR_ENV, SettingsStore, config_dir},
    state::StateOptions,
};
use colab_playground_core::{Error, ErrorKind, InstanceLock, paths::default_local_data_dir};
use colab_playground_shared::{
    errors,
    i18n::{fill_lenient, resolve, template},
    settings::LanguagePref,
};

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
    let lock = match &source {
        BackendSource::Real => default_local_data_dir()
            .ok_or_else(|| Error::new(ErrorKind::Io).detail("no data directory"))
            .and_then(|dir| InstanceLock::acquire(&dir))
            .map(Some),
        BackendSource::Mock(_) => store.dir().map(InstanceLock::acquire).transpose(),
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
