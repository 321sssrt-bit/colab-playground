use std::{fs, path::Path};

pub use colab_playground_shared::settings::{
    APP_DIR_NAME, AppearancePref, CONFIG_DIR_ENV, CORRUPT_SUFFIX, LanguagePref, LoadOutcome,
    Loaded, OnByDefault, SETTINGS_FILE, Settings, SettingsStore, config_dir, read_defaults,
};

/// A `file://` URL for `dir`, which is created first if missing, for `App::open_url` to show in
/// the system's file manager. Blocking: call it from a background task.
pub fn folder_url(dir: &Path) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let absolute =
        std::path::absolute(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    url::Url::from_directory_path(&absolute)
        .map(String::from)
        .map_err(|()| format!("{} cannot be written as a URL", absolute.display()))
}
