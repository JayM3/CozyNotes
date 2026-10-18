use serde::Serialize;
use serde_json::Value;
use std::{env, fs, io::Write, path::PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAsset {
    pub asset_id: String,
    pub mime_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAsset {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

fn data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = env::var_os("COZYNOTES_TEST_DATA_DIR") {
        let root = PathBuf::from(root);
        if !root.is_absolute() || root.to_string_lossy().starts_with(r"\\") {
            return Err("The debug test data directory must be an absolute local path.".into());
        }
        let data = root.join("data");
        fs::create_dir_all(&data).map_err(|error| error.to_string())?;
        return Ok(data);
    }
    app.path()
        .app_local_data_dir()
        .map(|root| root.join("data"))
        .map_err(|error| error.to_string())
}

fn asset_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = data_directory(app)?.join("images");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" | "image/x-ms-bmp" => Some("bmp"),
        _ => None,
    }
}

fn mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

pub fn is_valid_asset_id(asset_id: &str) -> bool {
    let Some((stem, extension)) = asset_id.rsplit_once('.') else {
        return false;
    };
    Uuid::parse_str(stem).is_ok() && mime_for_extension(extension).is_some()
}

fn asset_path(app: &AppHandle, asset_id: &str) -> Result<PathBuf, String> {
    if !is_valid_asset_id(asset_id) {
        return Err("Invalid image asset".into());
    }
    Ok(asset_directory(app)?.join(asset_id))
}

pub fn save(app: &AppHandle, mime_type: &str, bytes: &[u8]) -> Result<SavedAsset, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Images must be 25 MB or smaller.".into());
    }
    let mime_type = mime_type.to_ascii_lowercase();
    let extension = extension_for_mime(&mime_type).ok_or_else(|| {
        "This image format is not supported. Use PNG, JPEG, GIF, WebP, or BMP.".to_string()
    })?;
    let directory = asset_directory(app)?;
    let asset_id = format!("{}.{}", Uuid::new_v4(), extension);
    let path = directory.join(&asset_id);
    let temporary = directory.join(format!(".{asset_id}.tmp"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(SavedAsset {
        asset_id,
        mime_type,
    })
}

pub fn read(app: &AppHandle, asset_id: &str) -> Result<ImageAsset, String> {
    let path = asset_path(app, asset_id)?;
    let bytes = fs::read(path).map_err(|_| "This image is unavailable.".to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("This image is larger than the supported limit.".into());
    }
    let extension = asset_id
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .ok_or_else(|| "Invalid image asset".to_string())?;
    let mime_type =
        mime_for_extension(extension).ok_or_else(|| "Invalid image asset".to_string())?;
    Ok(ImageAsset {
        mime_type: mime_type.into(),
        bytes,
    })
}

pub fn remove(app: &AppHandle, asset_id: &str) {
    if let Ok(path) = asset_path(app, asset_id) {
        let _ = fs::remove_file(path);
    }
}

pub fn clone_document_assets(app: &AppHandle, document: &mut Value) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();
    let result = clone_node_assets(app, document, &mut copied);
    if result.is_err() {
        for asset_id in &copied {
            remove(app, asset_id);
        }
    }
    result.map(|()| copied)
}

fn clone_node_assets(
    app: &AppHandle,
    node: &mut Value,
    copied: &mut Vec<String>,
) -> Result<(), String> {
    if node.get("type").and_then(Value::as_str) == Some("image") {
        let asset_id = node
            .get("attrs")
            .and_then(Value::as_object)
            .and_then(|attrs| attrs.get("assetId"))
            .and_then(Value::as_str)
            .ok_or_else(|| "The note contains an invalid image asset.".to_string())?;
        let source = read(app, asset_id)?;
        let clone = save(app, &source.mime_type, &source.bytes)?;
        node["attrs"]["assetId"] = Value::String(clone.asset_id.clone());
        copied.push(clone.asset_id);
    }
    if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            clone_node_assets(app, child, copied)?;
        }
    }
    Ok(())
}
