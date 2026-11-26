use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
};
use colab_playground_core::{
    Error, ErrorKind, Result as CoreResult, backend::Backend, paths::write_atomic,
};
use colab_playground_shared::{
    defaults::sanitize,
    settings::{
        AppearancePref, LanguagePref, LoadOutcome, Loaded, OnByDefault, Settings, SettingsStore,
    },
};
use colab_playground_web::state::SettingsNotice;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::ApiError;
use crate::{http::StateData, platform};

pub(crate) type BackendBuilder =
    Arc<dyn Fn(&Settings) -> CoreResult<Arc<dyn Backend>> + Send + Sync>;

struct SettingsState {
    loaded: Loaded,
    notice: Option<SettingsNotice>,
}

#[derive(Clone)]
pub(crate) struct WebSettings {
    store: SettingsStore,
    state: Arc<Mutex<SettingsState>>,
    backend_builder: Option<BackendBuilder>,
}

impl WebSettings {
    pub(crate) fn load(store: SettingsStore) -> Self {
        let mut loaded = store.load();
        loaded.settings.defaults = sanitize(loaded.settings.defaults);
        let notice = notice_from_loaded(&loaded);
        Self {
            store,
            state: Arc::new(Mutex::new(SettingsState { loaded, notice })),
            backend_builder: None,
        }
    }

    pub(crate) fn with_backend_builder(mut self, builder: BackendBuilder) -> Self {
        self.backend_builder = Some(builder);
        self
    }

    pub(crate) fn initial_settings(&self) -> Settings {
        self.current()
    }

    pub(crate) fn current(&self) -> Settings {
        self.lock().loaded.settings.clone()
    }

    pub(crate) fn config_dir(&self) -> Option<PathBuf> {
        self.store.dir().map(PathBuf::from)
    }

    pub(crate) fn notice(&self) -> Option<SettingsNotice> {
        self.lock().notice.clone()
    }

    pub(crate) fn consume_notice(&self) -> Option<SettingsNotice> {
        self.lock().notice.take()
    }

    fn lock(&self) -> MutexGuard<'_, SettingsState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn view(&self, state: &SettingsState) -> SettingsView {
        let loaded = &state.loaded;
        let (load_status, corrupt_backup) = match &loaded.outcome {
            LoadOutcome::NoConfigDir => ("no_config_dir", None),
            LoadOutcome::Missing => ("missing", None),
            LoadOutcome::Loaded => ("loaded", None),
            LoadOutcome::Corrupt { backup, .. } => ("corrupt", backup.as_ref()),
        };
        SettingsView {
            language: loaded.settings.language,
            appearance: loaded.settings.appearance,
            defaults: loaded.settings.defaults.clone(),
            check_updates: loaded.settings.check_updates.0,
            wsl_distro: loaded.settings.wsl_distro.clone(),
            colab_path: loaded.settings.colab_path.clone(),
            colab_python: loaded.settings.colab_python.clone(),
            uses_wsl: platform::uses_wsl(),
            config_dir: self
                .store
                .dir()
                .map(|path| path.to_string_lossy().into_owned()),
            settings_file: self
                .store
                .file()
                .map(|path| full_path(&path).to_string_lossy().into_owned()),
            load_status,
            corrupt_backup: corrupt_backup.map(|path| path.to_string_lossy().into_owned()),
            reset_defaults: loaded.reset_defaults.clone(),
            settings_notice: state.notice.clone(),
        }
    }
}

fn full_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

fn notice_from_loaded(loaded: &Loaded) -> Option<SettingsNotice> {
    let (corrupt, corrupt_backup) = match &loaded.outcome {
        LoadOutcome::Corrupt { backup, .. } => (
            true,
            backup
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        ),
        LoadOutcome::NoConfigDir | LoadOutcome::Missing | LoadOutcome::Loaded => (false, None),
    };
    if !corrupt && loaded.reset_defaults.is_empty() {
        return None;
    }
    Some(SettingsNotice {
        corrupt,
        corrupt_backup,
        reset_defaults: loaded.reset_defaults.clone(),
    })
}

fn deserialize_nullable_string<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(Some(value.and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })))
}

#[derive(Serialize)]
pub(super) struct SettingsView {
    language: LanguagePref,
    appearance: AppearancePref,
    defaults: colab_playground_core::Defaults,
    check_updates: bool,
    wsl_distro: Option<String>,
    colab_path: Option<String>,
    colab_python: Option<String>,
    uses_wsl: bool,
    config_dir: Option<String>,
    settings_file: Option<String>,
    load_status: &'static str,
    corrupt_backup: Option<String>,
    reset_defaults: Vec<String>,
    settings_notice: Option<SettingsNotice>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SettingsPatch {
    language: Option<LanguagePref>,
    appearance: Option<AppearancePref>,
    defaults: Option<Map<String, Value>>,
    check_updates: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    wsl_distro: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    colab_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    colab_python: Option<Option<String>>,
}

fn apply_patch(base: &Settings, patch: &SettingsPatch) -> CoreResult<Settings> {
    let mut updated = base.clone();
    if let Some(language) = patch.language {
        updated.language = language;
    }
    if let Some(appearance) = patch.appearance {
        updated.appearance = appearance;
    }
    if let Some(check_updates) = patch.check_updates {
        updated.check_updates = OnByDefault(check_updates);
    }
    if let Some(wsl_distro) = &patch.wsl_distro {
        updated.wsl_distro.clone_from(wsl_distro);
    }
    if let Some(colab_path) = &patch.colab_path {
        updated.colab_path.clone_from(colab_path);
    }
    if let Some(colab_python) = &patch.colab_python {
        updated.colab_python.clone_from(colab_python);
    }
    let toolchain_patched = patch.colab_path.is_some() || patch.colab_python.is_some();
    if toolchain_patched && updated.colab_path.is_none() && updated.colab_python.is_some() {
        return Err(Error::new(ErrorKind::InvalidInput).with("host_interpreter_alone", "true"));
    }
    if let Some(defaults_patch) = &patch.defaults {
        let Value::Object(mut fields) =
            serde_json::to_value(&updated.defaults).expect("defaults serialize")
        else {
            unreachable!("defaults serialize as an object");
        };
        if defaults_patch.keys().any(|key| !fields.contains_key(key)) {
            return Err(Error::invalid("defaults", "unknown default field"));
        }
        fields.extend(defaults_patch.clone());
        let defaults = serde_json::from_value(Value::Object(fields))
            .map_err(|_| Error::invalid("defaults", "invalid default field"))?;
        updated.defaults = sanitize(defaults);
    }
    Ok(updated)
}

fn host_fields_changed(before: &Settings, after: &Settings) -> bool {
    before.wsl_distro != after.wsl_distro
        || before.colab_path != after.colab_path
        || before.colab_python != after.colab_python
}

fn save_outcome(store: &SettingsStore) -> LoadOutcome {
    if store.dir().is_some() {
        LoadOutcome::Loaded
    } else {
        LoadOutcome::NoConfigDir
    }
}

fn restore_settings_file(file: Option<&Path>, previous_bytes: Option<&[u8]>) {
    let Some(file) = file else {
        return;
    };
    match previous_bytes {
        Some(bytes) => {
            let _ = write_atomic(file, bytes);
        }
        None => {
            let _ = fs::remove_file(file);
        }
    }
}

pub(super) async fn get(State(state): State<StateData>) -> Result<Json<SettingsView>, ApiError> {
    let settings = state.settings;
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            let guard = settings.lock();
            settings.view(&guard)
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

#[derive(Serialize)]
pub(super) struct DismissNoticeResponse {
    notice: Option<SettingsNotice>,
}

pub(super) async fn dismiss_notice(
    State(state): State<StateData>,
    payload: Result<Json<Empty>, JsonRejection>,
) -> Result<Json<DismissNoticeResponse>, ApiError> {
    let Json(_) = payload?;
    let settings = state.settings;
    let web = state.web;
    let notice = tokio::task::spawn_blocking(move || {
        let consumed = settings.consume_notice();
        web.set_settings_notice(None);
        consumed
    })
    .await?;
    Ok(Json(DismissNoticeResponse { notice }))
}

enum NonHostResult {
    Saved(Box<SettingsView>),
    NeedsHostRebuild,
}

pub(super) async fn patch(
    State(state): State<StateData>,
    payload: Result<Json<SettingsPatch>, JsonRejection>,
) -> Result<Json<SettingsView>, ApiError> {
    let Json(patch) = payload?;
    let initial = state.settings.current();
    let prospective = apply_patch(&initial, &patch)?;
    let mut needs_host = host_fields_changed(&initial, &prospective);

    if !needs_host {
        let settings = state.settings.clone();
        let web = state.web.clone();
        let patch_clone = patch.clone();
        match state
            .web
            .run_backend(move |_, cancel| {
                let mut guard = settings.lock();
                let updated = apply_patch(&guard.loaded.settings, &patch_clone)?;
                if host_fields_changed(&guard.loaded.settings, &updated) {
                    return Ok(NonHostResult::NeedsHostRebuild);
                }
                cancel.commit()?;
                settings
                    .store
                    .save(&updated)
                    .map_err(|error| Error::new(ErrorKind::Io).detail(error.to_string()))?;
                web.set_defaults(updated.defaults.clone());
                web.set_settings_notice(None);
                guard.loaded = Loaded {
                    settings: updated,
                    outcome: save_outcome(&settings.store),
                    reset_defaults: Vec::new(),
                };
                guard.notice = None;
                Ok(NonHostResult::Saved(Box::new(settings.view(&guard))))
            })
            .await?
        {
            NonHostResult::Saved(view) => return Ok(Json(*view)),
            NonHostResult::NeedsHostRebuild => needs_host = true,
        }
    }

    debug_assert!(needs_host);
    let settings = state.settings;
    let response = state
        .web
        .apply_host_change(move |commit, cancel| {
            let mut guard = settings.lock();
            let updated = apply_patch(&guard.loaded.settings, &patch)?;
            let host_changed = host_fields_changed(&guard.loaded.settings, &updated);
            cancel.commit()?;

            let settings_file = settings.store.file();
            let previous_bytes = settings_file
                .as_deref()
                .and_then(|path| fs::read(path).ok());
            // Save before invoking the backend builder so a write failure never cleans up staged
            // plugin previews on disk.
            settings
                .store
                .save(&updated)
                .map_err(|error| Error::new(ErrorKind::Io).detail(error.to_string()))?;

            let rebuilt = if host_changed {
                if let Some(builder) = settings.backend_builder.as_ref() {
                    commit.discard_plugin_previews();
                    match builder(&updated) {
                        Ok(backend) => Some(backend),
                        Err(error) => {
                            restore_settings_file(
                                settings_file.as_deref(),
                                previous_bytes.as_deref(),
                            );
                            return Err(error);
                        }
                    }
                } else {
                    None
                }
            } else {
                None
            };

            let defaults = updated.defaults.clone();
            guard.loaded = Loaded {
                settings: updated,
                outcome: save_outcome(&settings.store),
                reset_defaults: Vec::new(),
            };
            guard.notice = None;
            if host_changed {
                commit.commit_host_change(rebuilt, defaults);
            } else {
                commit.commit_non_host_change(defaults);
            }
            Ok(settings.view(&guard))
        })
        .await?;
    Ok(Json(response))
}
