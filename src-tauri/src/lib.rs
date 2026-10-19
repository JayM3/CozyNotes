mod assets;
mod desk;
mod desktop;
mod document;
mod history;
mod ink;
mod operations;
mod settings;
mod snapping;
mod storage;

use operations::{OperationCoordinator, OperationKind, Preparation};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use settings::{SettingsResponse, SettingsState};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use storage::{Note, NoteSummary};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

struct Database(Mutex<Connection>);
struct WindowCoordinator(Mutex<HashSet<String>>);
struct DesktopState {
    settings: Mutex<SettingsState>,
    operations: OperationCoordinator,
    exit_approved: AtomicBool,
    tray_refresh_pending: AtomicBool,
    errors: desktop::AppErrors,
}

fn ensure_idle(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<DesktopState>().operations.busy() {
        Err("Another operation is in progress".into())
    } else {
        Ok(())
    }
}

fn require_library(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "library" {
        Ok(())
    } else {
        Err("This command is only available in the main menu".into())
    }
}

fn show_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

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
    let label = format!("note-{id}");
    {
        let mut opening = coordinator.0.lock().map_err(|error| error.to_string())?;
        ensure_idle(app)?;
        {
            let database = app.state::<Database>();
            let connection = database.0.lock().map_err(|error| error.to_string())?;
            storage::load_note(&connection, id, false)?;
        }
        if let Some(window) = app.get_webview_window(&label) {
            return show_window(&window);
        }
        if !opening.insert(label.clone()) {
            return Err("This note is already opening".into());
        }
    }
    let result = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("CozyNotes")
        .decorations(false)
        .maximizable(!cfg!(windows))
        .resizable(true)
        .visible(false)
        .inner_size(desk::DEFAULT_WIDTH, desk::DEFAULT_HEIGHT)
        .min_inner_size(desk::MIN_WIDTH, desk::MIN_HEIGHT)
        .build()
        .map_err(|error| error.to_string())
        .and_then(|window| {
            if let Err(error) = desk::attach(&window).and_then(|_| show_window(&window)) {
                let _ = window.destroy();
                return Err(error);
            }
            Ok(())
        });
    coordinator
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&label);
    result
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
fn set_note_favorite(app: tauri::AppHandle, id: String, favorite: bool) -> Result<(), String> {
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|e| e.to_string())?;
    ensure_idle(&app)?;
    let db = app.state::<Database>();
    let connection = db.0.lock().map_err(|e| e.to_string())?;
    if connection
        .execute(
            "UPDATE notes SET favorite=?1 WHERE id=?2 AND trashed_at IS NULL",
            params![favorite, id],
        )
        .map_err(|e| e.to_string())?
        == 0
    {
        return Err("Note not found".into());
    }
    drop(connection);
    let _ = app.emit(
        "note-favorite-changed",
        serde_json::json!({"id":id,"favorite":favorite}),
    );
    Ok(())
}

#[tauri::command]
fn list_note_history(
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<Vec<history::HistoryEntry>, String> {
    history::list(&*state.0.lock().map_err(|e| e.to_string())?, &id)
}

#[tauri::command]
fn get_note_history(
    state: tauri::State<'_, Database>,
    id: String,
    revision: i64,
) -> Result<history::HistoryVersion, String> {
    history::get(&*state.0.lock().map_err(|e| e.to_string())?, &id, revision)
}

#[tauri::command]
async fn restore_note_history(
    app: tauri::AppHandle,
    id: String,
    revision: i64,
) -> Result<Note, String> {
    let windows = app.state::<WindowCoordinator>();
    let guard = windows.0.lock().map_err(|e| e.to_string())?;
    ensure_idle(&app)?;
    let db = app.state::<Database>();
    let connection = db.0.lock().map_err(|e| e.to_string())?;
    let mut version = history::get(&connection, &id, revision)?;
    let copied = assets::clone_document_assets(&app, &mut version.document)?;
    let copy_id = uuid::Uuid::new_v4().to_string();
    let title = format!("{} (restored)", version.title);
    let note = match storage::insert_note(
        &connection,
        &copy_id,
        &version.document,
        &version.color,
        now(),
        &title,
    ) {
        Ok(note) => note,
        Err(error) => {
            for asset in copied {
                assets::remove(&app, &asset);
            }
            return Err(error);
        }
    };
    drop(connection);
    drop(guard);
    let _ = app.emit("note-created", &copy_id);
    desktop::refresh(&app);
    // A window failure must not make a successful restore look like a failed save.
    if let Err(error) = open_note_window(&app, &copy_id) {
        app.state::<DesktopState>().errors.record(format!(
            "Restored note saved to your library, but its window couldn't open. {error}"
        ));
    }
    Ok(note)
}

#[tauri::command]
fn get_note_window_state(window: tauri::WebviewWindow) -> Result<desk::Placement, String> {
    desk::current(&window)
}

#[tauri::command]
fn set_note_folded(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    folded: bool,
) -> Result<desk::Placement, String> {
    ensure_idle(&app)?;
    desk::set_folded(&window, folded)
}

#[tauri::command]
fn set_remember_desk(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<SettingsResponse, String> {
    require_library(&window)?;
    ensure_idle(&app)?;
    let state = app.state::<DesktopState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.set_remember_desk(enabled)?;
    Ok(settings.response())
}

#[tauri::command]
fn save_image_asset(
    app: tauri::AppHandle,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<assets::SavedAsset, String> {
    ensure_idle(&app)?;
    assets::save(&app, &mime_type, &bytes)
}

#[tauri::command]
fn read_image_asset(app: tauri::AppHandle, asset_id: String) -> Result<assets::ImageAsset, String> {
    assets::read(&app, &asset_id)
}

#[tauri::command]
fn delete_image_asset(app: tauri::AppHandle, asset_id: String) -> Result<(), String> {
    ensure_idle(&app)?;
    if !assets::is_valid_asset_id(&asset_id) {
        return Err("Invalid image asset".into());
    }
    let db = app.state::<Database>();
    let connection = db.0.lock().map_err(|e| e.to_string())?;
    let used: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE instr(document_json,?1)>0 UNION ALL SELECT 1 FROM note_history WHERE instr(document_json,?1)>0)", [&asset_id], |r|r.get(0)).map_err(|e|e.to_string())?;
    if used {
        return Err("This image is still used by a note or its history".into());
    }
    assets::remove(&app, &asset_id);
    Ok(())
}

#[tauri::command]
async fn create_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
) -> Result<Note, String> {
    let windows = app.state::<WindowCoordinator>();
    let guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let document = serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]});
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let note = storage::insert_note(&connection, &id, &document, "cream", timestamp, "")?;
    drop(connection);
    drop(guard);
    let _ = app.emit("note-created", &id);
    desktop::refresh(&app);
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
    {
        let mut opening = coordinator.0.lock().map_err(|error| error.to_string())?;
        if let Some(window) = app.get_webview_window("library") {
            show_window(&window)?;
            if focus_search.unwrap_or(false) {
                window
                    .emit("library-focus-search", ())
                    .map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        ensure_idle(&app)?;
        if !opening.insert("library".into()) {
            return Err("The main menu is already opening".into());
        }
    }
    let entry = if focus_search.unwrap_or(false) {
        "index.html?focusSearch=1"
    } else {
        "index.html"
    };
    let result = WebviewWindowBuilder::new(&app, "library", WebviewUrl::App(entry.into()))
        .title("CozyNotes")
        .decorations(false)
        .inner_size(615.0, 500.0)
        .min_inner_size(480.0, 500.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string());
    coordinator
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove("library");
    result
}

#[tauri::command]
fn save_note(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Database>,
    id: String,
    expected_revision: i64,
    document: Value,
    explicit_title: Option<String>,
) -> Result<Note, String> {
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    if !app
        .state::<DesktopState>()
        .operations
        .allows_save(window.label(), &format!("note-{id}"))
    {
        return Err("This editor is prepared for another operation".into());
    }
    let mut connection = state.0.lock().map_err(|error| error.to_string())?;
    let note = storage::save_document(
        &mut connection,
        &id,
        expected_revision,
        &document,
        now(),
        explicit_title.as_deref(),
    )?;
    drop(connection);
    let _ = app.emit("note-changed", &id);
    desktop::refresh(&app);
    Ok(note)
}

#[tauri::command]
fn trash_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE notes SET trashed_at = ?1 WHERE id = ?2 AND trashed_at IS NULL",
            params![now(), id],
        )
        .map_err(|error| error.to_string())?;
    let _ = app.emit("note-trashed", &id);
    drop(connection);
    desktop::refresh(&app);
    Ok(())
}

#[tauri::command]
fn restore_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE notes SET trashed_at = NULL WHERE id = ?1 AND trashed_at IS NOT NULL",
            [&id],
        )
        .map_err(|error| error.to_string())?;
    let _ = app.emit("note-restored", &id);
    drop(connection);
    desktop::refresh(&app);
    Ok(())
}

#[tauri::command]
fn set_note_color(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
    color: String,
) -> Result<(), String> {
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
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
    let windows = app.state::<WindowCoordinator>();
    let guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
    let connection = state.0.lock().map_err(|error| error.to_string())?;
    let source = storage::load_note(&connection, &id, false)?;
    let mut document = source
        .document
        .ok_or("This saved note needs recovery and cannot be duplicated.")?;
    let copied_assets = assets::clone_document_assets(&app, &mut document)?;
    let copy_id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let note = match storage::insert_note(
        &connection,
        &copy_id,
        &document,
        &source.color,
        timestamp,
        &source.explicit_title,
    ) {
        Ok(note) => note,
        Err(error) => {
            for asset_id in copied_assets {
                assets::remove(&app, &asset_id);
            }
            return Err(error);
        }
    };
    drop(connection);
    drop(guard);
    let _ = app.emit("note-created", &copy_id);
    desktop::refresh(&app);
    open_note_window(&app, &copy_id)?;
    Ok(note)
}

#[tauri::command]
fn purge_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
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
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
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

#[tauri::command]
fn take_app_error(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    require_library(&window)?;
    app.state::<DesktopState>().errors.take()
}

#[tauri::command]
fn get_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<SettingsResponse, String> {
    require_library(&window)?;
    app.state::<DesktopState>()
        .settings
        .lock()
        .map(|settings| settings.response())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_run_in_background(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<SettingsResponse, String> {
    require_library(&window)?;
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
    let state = app.state::<DesktopState>();
    let mut settings = state.settings.lock().map_err(|error| error.to_string())?;
    settings.set_run_in_background(enabled)?;
    let response = settings.response();
    drop(settings);
    if !enabled {
        show_window(&window)?;
    }
    Ok(response)
}

#[tauri::command]
fn editor_operation_active(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    operation_id: String,
) -> bool {
    window.label().starts_with("note-")
        && app
            .state::<DesktopState>()
            .operations
            .is_active(&operation_id, window.label())
}

#[tauri::command]
fn ack_editor_operation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    operation_id: String,
    success: bool,
) -> Result<(), String> {
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    app.state::<DesktopState>()
        .operations
        .acknowledge(window.label(), &operation_id, success)
}

fn begin_preparation(
    app: &tauri::AppHandle,
    kind: OperationKind,
    ids: Option<&[String]>,
) -> Result<Preparation, String> {
    let windows = app.state::<WindowCoordinator>();
    let opening = windows.0.lock().map_err(|error| error.to_string())?;
    if !opening.is_empty() {
        return Err("A window is opening. Try again in a moment.".into());
    }
    let labels = app
        .webview_windows()
        .keys()
        .filter(|label| {
            label.starts_with("note-")
                && ids.is_none_or(|ids| ids.iter().any(|id| label.as_str() == format!("note-{id}")))
        })
        .cloned()
        .collect();
    app.state::<DesktopState>().operations.begin(kind, labels)
}

async fn prepare_editors(app: &tauri::AppHandle, preparation: &Preparation) -> Result<(), String> {
    let payload = serde_json::json!({"operationId": preparation.operation_id, "kind": desktop::kind_name(preparation.kind)});
    for label in &preparation.window_labels {
        let window = app
            .get_webview_window(label)
            .ok_or("An editor closed during preparation. Try again.")?;
        window
            .emit("prepare-editor-operation", &payload)
            .map_err(|error| error.to_string())?;
    }
    let coordinator = app.state::<DesktopState>().operations.clone();
    coordinator
        .wait_for_preparation_with_timeout(preparation.clone(), Duration::from_secs(15))
        .await
}

fn finish_preparation(app: &tauri::AppHandle, preparation: &Preparation, outcome: &str) {
    // Status must be inactive before an editor receives cancellation.
    let coordinator = &app.state::<DesktopState>().operations;
    let _ = if outcome == "cancelled" {
        coordinator.cancel(&preparation.operation_id)
    } else {
        coordinator.finish(&preparation.operation_id)
    };
    let payload = serde_json::json!({"operationId": preparation.operation_id, "outcome": outcome});
    for label in &preparation.window_labels {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.emit("finish-editor-operation", &payload);
        }
    }
}

#[tauri::command]
async fn trash_notes(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    ids: Vec<String>,
) -> Result<(), String> {
    require_library(&window)?;
    let ids = selection_ids(ids)?;
    let preparation = begin_preparation(&app, OperationKind::Trash, Some(&ids))?;
    let result = async {
        prepare_editors(&app, &preparation).await?;
        {
            let state = app.state::<Database>();
            let mut connection = state.0.lock().map_err(|error| error.to_string())?;
            let revisions = ids
                .iter()
                .map(|id| {
                    storage::load_note(&connection, id, false)
                        .map(|note| (id.as_str(), note.revision))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let references = ids.iter().map(String::as_str).collect::<Vec<_>>();
            storage::trash_notes_batch(&mut connection, &references, &revisions, now())?;
        }
        // Keep the operation active until affected windows have been destroyed.
        let mut close_error = None;
        for label in &preparation.window_labels {
            if let Some(editor) = app.get_webview_window(label) {
                if let Err(error) = editor.destroy() {
                    close_error = Some(error.to_string());
                }
            }
        }
        let _ = app.emit(
            "notes-batch-changed",
            serde_json::json!({"ids": ids, "action": "trashed"}),
        );
        desktop::refresh(&app);
        Ok(close_error)
    }
    .await;
    match result {
        Ok(close_error) => {
            finish_preparation(&app, &preparation, "committed");
            if let Some(error) = close_error {
                desktop::report_error(
                    &app,
                    format!(
                        "Notes were saved and moved to Trash, but an editor couldn't close. {error}"
                    ),
                )
                .await;
            }
            Ok(())
        }
        Err(error) => {
            finish_preparation(&app, &preparation, "cancelled");
            Err(error)
        }
    }
}

fn selection_ids(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.is_empty()
        || ids
            .iter()
            .any(|id| id.is_empty() || id.chars().count() > 128)
    {
        return Err("Invalid selection".into());
    }
    let mut seen = HashSet::new();
    Ok(ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect())
}

#[tauri::command]
fn purge_notes(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    ids: Vec<String>,
) -> Result<(), String> {
    require_library(&window)?;
    let ids = selection_ids(ids)?;
    let windows = app.state::<WindowCoordinator>();
    let _guard = windows.0.lock().map_err(|error| error.to_string())?;
    ensure_idle(&app)?;
    let state = app.state::<Database>();
    let mut connection = state.0.lock().map_err(|error| error.to_string())?;
    let references = ids.iter().map(String::as_str).collect::<Vec<_>>();
    storage::purge_notes_batch(&mut connection, &references)?;
    drop(connection);
    let _ = app.emit(
        "notes-batch-changed",
        serde_json::json!({"ids": ids, "action": "purged"}),
    );
    desktop::refresh(&app);
    Ok(())
}

async fn exit_safely(app: &tauri::AppHandle) -> Result<(), String> {
    let preparation = begin_preparation(app, OperationKind::Exit, None)?;
    if let Err(error) = prepare_editors(app, &preparation).await {
        finish_preparation(app, &preparation, "cancelled");
        for label in &preparation.window_labels {
            if let Some(window) = app.get_webview_window(label) {
                let _ = show_window(&window);
            }
        }
        return Err(format!(
            "Couldn't exit CozyNotes. {error}. Your drafts remain open."
        ));
    }
    if let Err(error) = desk::flush(app) {
        finish_preparation(app, &preparation, "cancelled");
        return Err(format!("Couldn't remember your desk. {error}"));
    }
    // Prevent new mutations until the process exits, with all prepared drafts locked.
    app.state::<DesktopState>()
        .exit_approved
        .store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let path = database_path(&app.handle())?;
            let connection = storage::open_database(&path)?;
            app.manage(Database(Mutex::new(connection)));
            app.manage(desk::Desk::default());
            let settings_path = path.parent().and_then(|data| data.parent()).ok_or("Application data directory is unavailable")?.join("settings.json");
            app.manage(WindowCoordinator(Mutex::new(HashSet::new())));
            app.manage(DesktopState {
                settings: Mutex::new(SettingsState::load(settings_path, false)),
                operations: OperationCoordinator::default(),
                exit_approved: AtomicBool::new(false),
                tray_refresh_pending: AtomicBool::new(false),
                errors: desktop::AppErrors::default(),
            });
            let result = desktop::setup(app.handle());
            let state = app.state::<DesktopState>();
            state.settings.lock().map_err(|error| error.to_string())?.set_tray_available(result.is_ok(), result.err().map(|error| format!("The system tray is unavailable. Background operation is disabled for this session. {error}")));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.try_state::<DesktopState>().is_some_and(|state| state.operations.busy()) {
                    api.prevent_close();
                } else if window.label() == "library" && desktop::background_enabled(app) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            get_note,
            set_note_favorite,
            list_note_history,
            get_note_history,
            restore_note_history,
            get_note_window_state,
            set_note_folded,
            set_remember_desk,
            save_image_asset,
            read_image_asset,
            delete_image_asset,
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
            platform_capabilities,
            get_settings,
            take_app_error,
            set_run_in_background,
            trash_notes,
            purge_notes,
            editor_operation_active,
            ack_editor_operation
        ])
        .build(tauri::generate_context!())
        .expect("error while building CozyNotes")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Ready) {
                let app=app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = (|| -> Result<(),String> {
                        if !app.state::<DesktopState>().settings.lock().map_err(|e|e.to_string())?.response().remember_desk { return Ok(()); }
                        let ids=desk::open_ids(&*app.state::<Database>().0.lock().map_err(|e|e.to_string())?)?;
                        for id in ids { if let Err(error)=open_note_window(&app,&id) { app.state::<DesktopState>().errors.record(format!("Couldn't reopen a note. {error}")); } }
                        Ok(())
                    })();
                    if let Err(error)=result { desktop::report_error(&app,error).await; }
                });
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<DesktopState>();
                if state.exit_approved.load(Ordering::SeqCst) { return; }
                api.prevent_exit();
                if !state.operations.busy() && (!desktop::background_enabled(app) || code.is_some()) {
                    desktop::request_exit(app);
                }
            }
        });
}
