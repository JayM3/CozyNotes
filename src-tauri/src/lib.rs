mod document;
mod storage;

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use storage::{Note, NoteSummary};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

struct Database(Mutex<Connection>);
struct WindowCoordinator(Mutex<()>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformCapabilities {
    absolute_window_position: bool,
    always_on_top: bool,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// Call from async commands: WebView2 can deadlock on Windows when a synchronous
// IPC handler creates a webview window on the main thread.
fn open_note_window(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let coordinator = app.state::<WindowCoordinator>();
    let _guard = coordinator.0.lock().map_err(|error| error.to_string())?;
    let label = format!("note-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("CozyNotes")
        .decorations(false)
        .resizable(true)
        .inner_size(360.0, 400.0)
        .min_inner_size(320.0, 240.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_notes(
    state: tauri::State<'_, Database>,
    trashed: bool,
    query: String,
    color: Option<String>,
) -> Result<Vec<NoteSummary>, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    storage::list_notes(&connection, trashed, &query, color.as_deref())
}

#[tauri::command]
fn get_note(state: tauri::State<'_, Database>, id: String) -> Result<Note, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    storage::load_note(&connection, &id, false)
}

#[tauri::command]
async fn create_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
) -> Result<Note, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let document = serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]});
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let note = storage::insert_note(&connection, &id, &document, "cream", timestamp)?;
    drop(connection);
    let _ = app.emit("note-created", &id);
    open_note_window(&app, &id)?;
    Ok(note)
}

#[tauri::command]
async fn open_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    storage::load_note(&connection, &id, false)?;
    drop(connection);
    open_note_window(&app, &id)
}

#[tauri::command]
async fn show_library(app: tauri::AppHandle, focus_search: Option<bool>) -> Result<(), String> {
    let coordinator = app.state::<WindowCoordinator>();
    let _guard = coordinator.0.lock().map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window("library") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        if focus_search.unwrap_or(false) {
            window
                .emit("library-focus-search", ())
                .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let entry = if focus_search.unwrap_or(false) {
        "index.html?focusSearch=1"
    } else {
        "index.html"
    };
    WebviewWindowBuilder::new(&app, "library", WebviewUrl::App(entry.into()))
        .title("CozyNotes")
        .decorations(false)
        .inner_size(615.0, 500.0)
        .min_inner_size(480.0, 500.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
    expected_revision: i64,
    document: Value,
) -> Result<Note, String> {
    let mut connection = state.0.lock().map_err(|error| error.to_string())?;
    let note = storage::save_document(&mut connection, &id, expected_revision, &document, now())?;
    drop(connection);
    let _ = app.emit("note-changed", &id);
    Ok(note)
}

#[tauri::command]
fn trash_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE notes SET trashed_at = ?1 WHERE id = ?2 AND trashed_at IS NULL",
            params![now(), id],
        )
        .map_err(|error| error.to_string())?;
    let _ = app.emit("note-trashed", &id);
    Ok(())
}

#[tauri::command]
fn restore_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE notes SET trashed_at = NULL WHERE id = ?1 AND trashed_at IS NOT NULL",
            [&id],
        )
        .map_err(|error| error.to_string())?;
    let _ = app.emit("note-restored", &id);
    Ok(())
}

#[tauri::command]
fn set_note_color(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
    color: String,
) -> Result<(), String> {
    if !storage::valid_color(&color) {
        return Err("Invalid paper color".into());
    }
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE notes SET color = ?1 WHERE id = ?2 AND trashed_at IS NULL",
            params![color, id],
        )
        .map_err(|error| error.to_string())?;
    let _ = app.emit("note-changed", &id);
    Ok(())
}

#[tauri::command]
async fn duplicate_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<Note, String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let source = storage::load_note(&connection, &id, false)?;
    let document = source
        .document
        .ok_or("This saved note needs recovery and cannot be duplicated.")?;
    let copy_id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let note = storage::insert_note(&connection, &copy_id, &document, &source.color, timestamp)?;
    drop(connection);
    let _ = app.emit("note-created", &copy_id);
    open_note_window(&app, &copy_id)?;
    Ok(note)
}

#[tauri::command]
fn purge_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM notes WHERE id = ?1 AND trashed_at IS NOT NULL",
            [&id],
        )
        .map_err(|error| error.to_string())?;
    let _ = app.emit("note-purged", &id);
    Ok(())
}

#[tauri::command]
fn empty_trash(app: tauri::AppHandle, state: tauri::State<'_, Database>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM notes WHERE trashed_at IS NOT NULL", [])
        .map_err(|error| error.to_string())?;
    let _ = app.emit("trash-emptied", ());
    Ok(())
}

#[tauri::command]
fn platform_capabilities() -> PlatformCapabilities {
    #[cfg(target_os = "linux")]
    let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind == "wayland")
        || (std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none());
    #[cfg(not(target_os = "linux"))]
    let wayland = false;
    PlatformCapabilities {
        absolute_window_position: !wayland,
        always_on_top: !wayland,
    }
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("COZYNOTES_TEST_DATA_DIR") {
        let root = PathBuf::from(root);
        if !root.is_absolute() || root.to_string_lossy().starts_with(r"\\") {
            return Err("The debug test data directory must be an absolute local path.".into());
        }
        let data = root.join("data");
        fs::create_dir_all(&data).map_err(|error| error.to_string())?;
        return Ok(data.join("cozynotes.sqlite"));
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("data");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join("cozynotes.sqlite"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = show_library(app, None).await;
            });
        }))
        .setup(|app| {
            let path = database_path(&app.handle())?;
            let connection = storage::open_database(&path)?;
            app.manage(Database(Mutex::new(connection)));
            app.manage(WindowCoordinator(Mutex::new(())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            get_note,
            create_note,
            open_note,
            show_library,
            save_note,
            set_note_color,
            duplicate_note,
            trash_note,
            restore_note,
            purge_note,
            empty_trash,
            platform_capabilities
        ])
        .run(tauri::generate_context!())
        .expect("error while running CozyNotes");
}
