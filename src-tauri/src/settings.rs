use crate::note_defaults::{NoteDefaults, ResetSize};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Arc,
};

const SETTINGS_VERSION: u32 = 2;
const WRITE_ERROR: &str =
    "Settings could not be persisted; the previous effective preference remains active";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedSettings {
    version: u32,
    run_in_background: bool,
    #[serde(default = "default_true")]
    remember_desk: bool,
    #[serde(default)]
    note_defaults: Option<serde_json::Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    pub note_defaults: NoteDefaults,
    pub remember_desk: bool,
    pub run_in_background: bool,
    pub open_on_startup: bool,
    pub tray_available: bool,
    pub warning: Option<String>,
}

pub struct SettingsState {
    note_defaults: NoteDefaults,
    reset_size: Arc<ResetSize>,
    remember_desk: bool,
    path: PathBuf,
    run_in_background: bool,
    tray_available: bool,
    settings_warning: Option<String>,
    tray_warning: Option<String>,
}

impl SettingsState {
    pub fn load(path: PathBuf, tray_available: bool) -> Self {
        let mut note_defaults = NoteDefaults::default();
        let (run_in_background, remember_desk, settings_warning) = match fs::read(&path) {
            Ok(contents) => match serde_json::from_slice::<PersistedSettings>(&contents) {
                Ok(settings) if matches!(settings.version, 1 | SETTINGS_VERSION) => {
                    let (parsed, invalid) =
                        NoteDefaults::from_saved(settings.note_defaults.as_ref());
                    note_defaults = parsed;
                    (settings.run_in_background, settings.remember_desk, invalid.then(|| "Some saved note defaults were invalid; factory values are active for those fields.".into()))
                }
                Ok(_) => (
                    true,
                    true,
                    Some("Saved settings use an unsupported version; defaults are active.".into()),
                ),
                Err(_) => (
                    true,
                    true,
                    Some("Saved settings could not be read; defaults are active.".into()),
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (true, true, None),
            Err(_) => (
                true,
                true,
                Some("Saved settings could not be read; defaults are active.".into()),
            ),
        };

        Self {
            reset_size: Arc::new(ResetSize::new(&note_defaults)),
            note_defaults,
            remember_desk,
            path,
            run_in_background,
            tray_available,
            settings_warning,
            tray_warning: None,
        }
    }

    pub fn response(&self) -> SettingsResponse {
        SettingsResponse {
            note_defaults: self.note_defaults.clone(),
            remember_desk: self.remember_desk,
            run_in_background: self.run_in_background,
            open_on_startup: false,
            tray_available: self.tray_available,
            warning: self
                .settings_warning
                .clone()
                .or_else(|| self.tray_warning.clone()),
        }
    }

    pub fn set_tray_available(&mut self, available: bool, warning: Option<String>) {
        self.tray_available = available;
        self.tray_warning = warning;
    }

    pub fn set_run_in_background(&mut self, enabled: bool) -> Result<(), String> {
        self.persist(enabled, self.remember_desk, self.note_defaults.clone())
    }

    pub fn set_remember_desk(&mut self, enabled: bool) -> Result<(), String> {
        self.persist(self.run_in_background, enabled, self.note_defaults.clone())
    }

    pub fn note_defaults(&self) -> NoteDefaults {
        self.note_defaults.clone()
    }

    pub fn reset_size(&self) -> Arc<ResetSize> {
        Arc::clone(&self.reset_size)
    }

    pub fn set_note_defaults(&mut self, defaults: NoteDefaults) -> Result<NoteDefaults, String> {
        defaults.validate()?;
        self.persist(self.run_in_background, self.remember_desk, defaults)?;
        Ok(self.note_defaults())
    }

    fn persist(
        &mut self,
        background: bool,
        remember_desk: bool,
        defaults: NoteDefaults,
    ) -> Result<(), String> {
        let settings = PersistedSettings {
            version: SETTINGS_VERSION,
            run_in_background: background,
            remember_desk,
            note_defaults: Some(
                serde_json::to_value(&defaults).map_err(|_| WRITE_ERROR.to_string())?,
            ),
        };
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| WRITE_ERROR.to_string())?;
        let parent = self.path.parent().ok_or_else(|| WRITE_ERROR.to_string())?;

        let temporary = parent.join(format!(".cozynotes-settings-{}.tmp", uuid::Uuid::new_v4()));
        let write_result = (|| -> std::io::Result<()> {
            fs::create_dir_all(parent)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.path)?;
            Ok(())
        })();

        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(WRITE_ERROR.into());
        }
        self.reset_size.update(&defaults);
        self.note_defaults = defaults;
        self.run_in_background = background;
        self.remember_desk = remember_desk;
        self.settings_warning = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn temp_path(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("cozynotes-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root.join(name)
    }

    #[test]
    fn missing_settings_use_background_default_without_warning() {
        let state = SettingsState::load(temp_path("settings.json"), true);
        assert_eq!(state.response().run_in_background, true);
        assert_eq!(state.response().tray_available, true);
        assert_eq!(state.response().warning, None);
    }

    #[test]
    fn unreadable_settings_use_default_and_expose_warning() {
        let path = temp_path("settings.json");
        fs::write(&path, "{not-json").unwrap();
        let state = SettingsState::load(path, true);
        assert!(state.response().run_in_background);
        assert!(state.response().warning.is_some());
    }

    #[test]
    fn failed_write_keeps_previous_effective_value() {
        let path = temp_path("settings.json");
        fs::create_dir(&path).unwrap();
        let mut state = SettingsState::load(path, true);
        let error = state.set_run_in_background(false).unwrap_err();
        assert_eq!(error, WRITE_ERROR);
        assert!(state.response().run_in_background);
    }

    #[test]
    fn successful_write_is_read_back() {
        let path = temp_path("settings.json");
        let mut state = SettingsState::load(path.clone(), true);
        state.set_run_in_background(false).unwrap();
        assert!(!state.response().run_in_background);
        assert!(!SettingsState::load(path, true).response().run_in_background);
    }

    #[test]
    fn old_settings_default_to_remembering_desk_and_updates_preserve_background() {
        let path = temp_path("settings.json");
        fs::write(&path, r#"{"version":1,"runInBackground":false}"#).unwrap();
        let mut state = SettingsState::load(path.clone(), true);
        assert!(state.response().remember_desk);
        state.set_remember_desk(false).unwrap();
        state.set_run_in_background(true).unwrap();
        let restored = SettingsState::load(path, true).response();
        assert!(!restored.remember_desk);
        assert!(restored.run_in_background);
    }
    #[test]
    fn defaults_roundtrip_preserves_app_settings_and_updates_existing_reset_cache() {
        let path = temp_path("defaults.json");
        fs::write(
            &path,
            r#"{"version":1,"runInBackground":false,"rememberDesk":false}"#,
        )
        .unwrap();
        let mut state = SettingsState::load(path.clone(), true);
        let cache = state.reset_size();
        let defaults = NoteDefaults {
            color: "sage".into(),
            font_family: "nunito".into(),
            font_size: 20,
            width: 400,
            height: 500,
        };
        assert_eq!(state.set_note_defaults(defaults.clone()).unwrap(), defaults);
        assert_eq!(cache.get(), (400, 500));
        state.set_run_in_background(true).unwrap();
        let restored = SettingsState::load(path, true).response();
        assert_eq!(restored.note_defaults, defaults);
        assert!(restored.run_in_background);
        assert!(!restored.remember_desk);
    }

    #[test]
    fn invalid_saved_fields_preserve_valid_defaults_and_app_preferences() {
        let path = temp_path("invalid-defaults.json");
        fs::write(&path, r#"{"version":2,"runInBackground":false,"rememberDesk":false,"noteDefaults":{"color":"sage","fontFamily":"unknown","fontSize":17,"width":400,"height":null}}"#).unwrap();
        let settings = SettingsState::load(path, true).response();
        assert!(!settings.run_in_background);
        assert!(!settings.remember_desk);
        assert_eq!(
            settings.note_defaults,
            NoteDefaults {
                color: "sage".into(),
                width: 400,
                ..Default::default()
            }
        );
        assert!(settings.warning.is_some());
    }

    #[test]
    fn rejected_defaults_and_failed_writes_do_not_change_effective_values_or_cache() {
        let path = temp_path("failed-defaults.json");
        let mut state = SettingsState::load(path.clone(), true);
        let cache = state.reset_size();
        for defaults in [
            NoteDefaults {
                font_size: 17,
                ..Default::default()
            },
            NoteDefaults {
                width: 304,
                ..Default::default()
            },
            NoteDefaults {
                height: 1601,
                ..Default::default()
            },
            NoteDefaults {
                font_family: "bad".into(),
                ..Default::default()
            },
        ] {
            assert!(state.set_note_defaults(defaults).is_err());
        }
        fs::create_dir(&path).unwrap();
        assert!(
            state
                .set_note_defaults(NoteDefaults {
                    width: 400,
                    ..Default::default()
                })
                .is_err()
        );
        assert_eq!(state.note_defaults(), NoteDefaults::default());
        assert_eq!(cache.get(), (305, 385));
    }
}
