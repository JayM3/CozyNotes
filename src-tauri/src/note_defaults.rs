use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

pub const DEFAULT_FONT: &str = "source-sans-3";
pub const DEFAULT_FONT_SIZE: u8 = 16;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteDefaults {
    pub color: String,
    pub font_family: String,
    pub font_size: u8,
    pub width: u32,
    pub height: u32,
}

impl Default for NoteDefaults {
    fn default() -> Self {
        Self {
            color: "cream".into(),
            font_family: DEFAULT_FONT.into(),
            font_size: DEFAULT_FONT_SIZE,
            width: 305,
            height: 385,
        }
    }
}

pub fn valid_font(font: &str) -> bool {
    matches!(font, "source-sans-3" | "nunito")
}

pub fn valid_font_size(size: u8) -> bool {
    matches!(size, 12 | 14 | 16 | 18 | 20 | 24)
}

impl NoteDefaults {
    pub fn validate(&self) -> Result<(), String> {
        if !crate::storage::valid_color(&self.color) {
            return Err("Choose a supported paper color.".into());
        }
        if !valid_font(&self.font_family) {
            return Err("Choose a supported note font.".into());
        }
        if !valid_font_size(self.font_size) {
            return Err("Choose a supported text size.".into());
        }
        if !(305..=1600).contains(&self.width) {
            return Err("Width must be a whole number from 305 to 1600.".into());
        }
        if !(240..=1600).contains(&self.height) {
            return Err("Height must be a whole number from 240 to 1600.".into());
        }
        Ok(())
    }

    // Missing fields use factory values; invalid fields do not discard valid preferences.
    pub fn from_saved(value: Option<&serde_json::Value>) -> (Self, bool) {
        let mut result = Self::default();
        let Some(value) = value else {
            return (result, false);
        };
        let Some(fields) = value.as_object() else {
            return (result, true);
        };
        let mut invalid = false;
        for (key, value) in fields {
            let mut candidate = serde_json::to_value(&result).expect("serializable defaults");
            candidate[key] = value.clone();
            match serde_json::from_value::<Self>(candidate) {
                Ok(parsed) if parsed.validate().is_ok() => result = parsed,
                _ => invalid = true,
            }
        }
        (result, invalid)
    }
}

// One atomic value keeps both dimensions consistent in the native window callback.
pub struct ResetSize(AtomicU64);

impl ResetSize {
    pub fn new(defaults: &NoteDefaults) -> Self {
        Self(AtomicU64::new(Self::pack(defaults)))
    }
    fn pack(defaults: &NoteDefaults) -> u64 {
        ((defaults.width as u64) << 32) | defaults.height as u64
    }
    pub fn update(&self, defaults: &NoteDefaults) {
        self.0.store(Self::pack(defaults), Ordering::Relaxed);
    }
    pub fn get(&self) -> (u32, u32) {
        let value = self.0.load(Ordering::Relaxed);
        ((value >> 32) as u32, value as u32)
    }
}
