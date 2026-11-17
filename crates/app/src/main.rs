#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use colab_playground::{
    app,
    backend::{BACKEND_ENV, USAGE, source_from_args},
    platform,
    settings::{CONFIG_DIR_ENV, SettingsStore, config_dir},
    state::StateOptions,
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
            eprintln!("colab-playground: {error}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let store = SettingsStore::new(config_dir(std::env::var_os(CONFIG_DIR_ENV)));
    app::run(StateOptions {
        source,
        store,
        os_locale: platform::os_locale(),
    });
}
