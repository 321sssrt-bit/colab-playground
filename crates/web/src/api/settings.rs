use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
};
use colab_playground_core::{Error, ErrorKind};
use colab_playground_shared::{
    defaults::sanitize,
    settings::{
        AppearancePref, LanguagePref, LoadOutcome, Loaded, OnByDefault, Settings, SettingsStore,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::ApiError;
use crate::http::StateData;

#[derive(Clone)]
pub(crate) struct WebSettings {
    store: SettingsStore,
    loaded: Arc<Mutex<Loaded>>,
}

impl WebSettings {
    pub(crate) fn load(store: SettingsStore) -> Self {
        let mut loaded = store.load();
        loaded.settings.defaults = sanitize(loaded.settings.defaults);
        Self {
            store,
            loaded: Arc::new(Mutex::new(loaded)),
        }
    }

    pub(crate) fn initial_settings(&self) -> Settings {
        self.current()
    }

    pub(crate) fn current(&self) -> Settings {
        self.loaded.lock().expect("settings lock").settings.clone()
    }

    pub(crate) fn config_dir(&self) -> Option<PathBuf> {
        self.store.dir().map(PathBuf::from)
    }

    fn view(&self, loaded: &Loaded) -> SettingsView {
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
            config_dir: self
                .store
                .dir()
                .map(|path| path.to_string_lossy().into_owned()),
            load_status,
            corrupt_backup: corrupt_backup.map(|path| path.to_string_lossy().into_owned()),
            reset_defaults: loaded.reset_defaults.clone(),
        }
    }
}

#[derive(Serialize)]
pub(super) struct SettingsView {
    language: LanguagePref,
    appearance: AppearancePref,
    defaults: colab_playground_core::Defaults,
    check_updates: bool,
    config_dir: Option<String>,
    load_status: &'static str,
    corrupt_backup: Option<String>,
    reset_defaults: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SettingsPatch {
    language: Option<LanguagePref>,
    appearance: Option<AppearancePref>,
    defaults: Option<Map<String, Value>>,
    check_updates: Option<bool>,
}

pub(super) async fn get(State(state): State<StateData>) -> Result<Json<SettingsView>, ApiError> {
    let settings = state.settings;
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            settings.view(&settings.loaded.lock().expect("settings lock"))
        })
        .await?,
    ))
}

pub(super) async fn patch(
    State(state): State<StateData>,
    payload: Result<Json<SettingsPatch>, JsonRejection>,
) -> Result<Json<SettingsView>, ApiError> {
    let Json(patch) = payload?;
    let settings = state.settings;
    let response = state
        .web
        .run_backend(move |backend, cancel| {
            let mut loaded = settings.loaded.lock().expect("settings lock");
            let mut updated = loaded.settings.clone();
            if let Some(language) = patch.language {
                updated.language = language;
            }
            if let Some(appearance) = patch.appearance {
                updated.appearance = appearance;
            }
            if let Some(check_updates) = patch.check_updates {
                updated.check_updates = OnByDefault(check_updates);
            }
            if let Some(patch) = patch.defaults {
                let Value::Object(mut fields) =
                    serde_json::to_value(&updated.defaults).expect("defaults serialize")
                else {
                    unreachable!("defaults serialize as an object");
                };
                if patch.keys().any(|key| !fields.contains_key(key)) {
                    return Err(Error::invalid("defaults", "unknown default field"));
                }
                fields.extend(patch);
                let defaults = serde_json::from_value(Value::Object(fields))
                    .map_err(|_| Error::invalid("defaults", "invalid default field"))?;
                updated.defaults = sanitize(defaults);
            }
            cancel.commit()?;
            settings
                .store
                .save(&updated)
                .map_err(|error| Error::new(ErrorKind::Io).detail(error.to_string()))?;
            backend.set_defaults(updated.defaults.clone());
            *loaded = Loaded {
                settings: updated,
                outcome: if settings.store.dir().is_some() {
                    LoadOutcome::Loaded
                } else {
                    LoadOutcome::NoConfigDir
                },
                reset_defaults: Vec::new(),
            };
            Ok(settings.view(&loaded))
        })
        .await?;
    Ok(Json(response))
}
