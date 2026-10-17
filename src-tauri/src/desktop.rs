use crate::{Database, DesktopState, operations::OperationKind, storage};
use std::{
    sync::{Mutex, atomic::Ordering},
    time::Duration,
};
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
};

const TRAY_ID: &str = "cozynotes";

#[derive(Default)]
pub struct AppErrors(Mutex<Option<String>>);

impl AppErrors {
    pub fn record(&self, error: String) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(error);
        }
    }

    pub fn take(&self) -> Result<Option<String>, String> {
        self.0
            .lock()
            .map(|mut pending| pending.take())
            .map_err(|error| error.to_string())
    }
}

fn menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let notes = {
        let state = app.state::<Database>();
        let connection = state.0.lock().map_err(|error| error.to_string())?;
        storage::active_note_metadata(&connection)?
    };
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    let submenu = Submenu::new(app, "Notes", true).map_err(|error| error.to_string())?;
    if notes.is_empty() {
        let item = MenuItem::with_id(app, "empty", "No notes yet", false, None::<&str>)
            .map_err(|error| error.to_string())?;
        submenu.append(&item).map_err(|error| error.to_string())?;
    }
    for note in notes {
        // Native menus interpret ampersands as keyboard mnemonics on Windows.
        let title = note.title.replace('&', "&&");
        let item = MenuItem::with_id(app, format!("note:{}", note.id), title, true, None::<&str>)
            .map_err(|error| error.to_string())?;
        submenu.append(&item).map_err(|error| error.to_string())?;
    }
    let show = MenuItem::with_id(app, "show-library", "Show main menu", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let exit = MenuItem::with_id(app, "exit", "Exit CozyNotes", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    menu.append_items(&[&submenu, &show, &exit])
        .map_err(|error| error.to_string())?;
    Ok(menu)
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("The application icon is unavailable")?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("CozyNotes")
        .menu(&menu(app)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = if id == "show-library" {
                    crate::show_library(app.clone(), None).await.and_then(|_| {
                        if let Some(window) = app.get_webview_window("library") {
                            window
                                .emit("library-show-notes", ())
                                .map_err(|error| error.to_string())?;
                        }
                        Ok(())
                    })
                } else if id == "exit" {
                    crate::exit_safely(&app).await
                } else if let Some(note_id) = id.strip_prefix("note:") {
                    crate::open_note(app.clone(), app.state::<Database>(), note_id.to_string())
                        .await
                } else {
                    Ok(())
                };
                if let Err(error) = result {
                    report_error(&app, error).await;
                }
            });
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn refresh(app: &tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    if state.tray_refresh_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // One refresh after a burst of autosaves, without loading note documents.
        let _ =
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(120)))
                .await;
        app.state::<DesktopState>()
            .tray_refresh_pending
            .store(false, Ordering::SeqCst);
        let menu_app = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let Some(tray) = menu_app.tray_by_id(TRAY_ID) else {
                return Ok(());
            };
            tray.set_menu(Some(menu(&menu_app)?))
                .map_err(|error| error.to_string())
        })
        .await;
        if let Ok(Err(error)) = result {
            report_error(&app, format!("Couldn't update the Notes menu. {error}")).await;
        }
    });
}

pub async fn report_error(app: &tauri::AppHandle, error: String) {
    app.state::<DesktopState>().errors.record(error.clone());
    let _ = crate::show_library(app.clone(), None).await;
    if let Some(window) = app.get_webview_window("library") {
        let _ = window.emit("app-error", error);
    }
}

pub fn background_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<DesktopState>()
        .and_then(|state| {
            state.settings.lock().ok().map(|settings| {
                let value = settings.response();
                value.run_in_background && value.tray_available
            })
        })
        .unwrap_or(false)
}

pub fn request_exit(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::exit_safely(&app).await {
            report_error(&app, error).await;
        }
    });
}

pub fn kind_name(kind: OperationKind) -> &'static str {
    match kind {
        OperationKind::Trash => "trash",
        OperationKind::Exit => "exit",
    }
}

#[cfg(test)]
mod tests {
    use super::AppErrors;

    #[test]
    fn queued_error_survives_until_the_library_consumes_it() {
        let errors = AppErrors::default();
        errors.record("Your drafts remain open.".into());
        assert_eq!(
            errors.take().unwrap(),
            Some("Your drafts remain open.".into())
        );
        assert_eq!(errors.take().unwrap(), None);
    }

    #[test]
    fn pending_error_keeps_the_latest_failure() {
        let errors = AppErrors::default();
        errors.record("First failure".into());
        errors.record("Latest failure".into());
        assert_eq!(errors.take().unwrap(), Some("Latest failure".into()));
    }
}
