use crate::{Database, DesktopState};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Mutex, atomic::Ordering},
};
use tauri::{LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

pub const FOLDED_HEIGHT: f64 = 52.0;
pub const DEFAULT_WIDTH: f64 = 305.0;
pub const DEFAULT_HEIGHT: f64 = 385.0;
pub const MIN_WIDTH: f64 = 305.0;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub width: f64,
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub folded: bool,
    pub is_open: bool,
}

impl Default for Placement {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            folded: false,
            is_open: false,
        }
    }
}

#[derive(Default)]
pub struct Desk(pub Mutex<HashMap<String, Placement>>);

pub fn load(connection: &Connection, id: &str) -> Result<Placement, String> {
    connection
        .query_row(
            "SELECT width,height,x,y,folded,is_open FROM note_windows WHERE note_id=?1",
            [id],
            |row| {
                Ok(Placement {
                    width: row.get(0)?,
                    height: row.get(1)?,
                    x: row.get(2)?,
                    y: row.get(3)?,
                    folded: row.get(4)?,
                    is_open: row.get(5)?,
                })
            },
        )
        .optional()
        .map(|v| v.unwrap_or_default())
        .map_err(|e| e.to_string())
}

pub fn save(connection: &Connection, id: &str, p: &Placement) -> Result<(), String> {
    connection.execute("INSERT INTO note_windows (note_id,width,height,x,y,folded,is_open) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM notes WHERE id=?1) ON CONFLICT(note_id) DO UPDATE SET width=excluded.width,height=excluded.height,x=excluded.x,y=excluded.y,folded=excluded.folded,is_open=excluded.is_open", params![id,p.width,p.height,p.x,p.y,p.folded,p.is_open]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn open_ids(connection: &Connection) -> Result<Vec<String>, String> {
    let mut query = connection.prepare("SELECT w.note_id FROM note_windows w JOIN notes n ON n.id=w.note_id WHERE w.is_open=1 AND n.trashed_at IS NULL ORDER BY w.note_id").map_err(|e|e.to_string())?;
    query
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[derive(Clone, Copy, Debug)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

// Store logical sizes, physical origins. Pick the work area with the most
// overlap, falling back to the primary monitor when a display disappeared.
pub fn fit(p: &Placement, areas: &[WorkArea]) -> Placement {
    let mut result = p.clone();
    let Some(first) = areas.first() else {
        return result;
    };
    let selected = areas
        .iter()
        .max_by_key(|area| {
            let x = p.x.unwrap_or(first.x) as i64;
            let y = p.y.unwrap_or(first.y) as i64;
            let right = x + (p.width * area.scale) as i64;
            let bottom = y + (if p.folded { FOLDED_HEIGHT } else { p.height } * area.scale) as i64;
            (right.min(area.x as i64 + area.width as i64) - x.max(area.x as i64)).max(0)
                * (bottom.min(area.y as i64 + area.height as i64) - y.max(area.y as i64)).max(0)
        })
        .unwrap_or(first);
    let intersects = p.x.zip(p.y).is_some_and(|(x, y)| {
        (x as i64) < selected.x as i64 + selected.width as i64
            && (y as i64) < selected.y as i64 + selected.height as i64
            && x as f64 + p.width * selected.scale > selected.x as f64
            && y as f64 + p.height * selected.scale > selected.y as f64
    });
    let area = if intersects { selected } else { first };
    result.width = p
        .width
        .max(MIN_WIDTH)
        .min((area.width as f64 / area.scale).max(MIN_WIDTH));
    result.height = p
        .height
        .max(240.0)
        .min((area.height as f64 / area.scale).max(240.0));
    let width = (result.width * area.scale).round() as i32;
    let height = (if result.folded {
        FOLDED_HEIGHT
    } else {
        result.height
    } * area.scale)
        .round() as i32;
    result.x = Some(p.x.unwrap_or(area.x + 32).clamp(
        area.x,
        (area.x as i64 + area.width as i64 - width as i64).max(area.x as i64) as i32,
    ));
    result.y = Some(p.y.unwrap_or(area.y + 32).clamp(
        area.y,
        (area.y as i64 + area.height as i64 - height as i64).max(area.y as i64) as i32,
    ));
    result
}

pub fn current(window: &WebviewWindow) -> Result<Placement, String> {
    let id = window
        .label()
        .strip_prefix("note-")
        .ok_or("This command needs a note window")?;
    let app = window.app_handle();
    if let Some(p) = app
        .state::<Desk>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
    {
        return Ok(p);
    }
    load(
        &*app
            .state::<Database>()
            .0
            .lock()
            .map_err(|e| e.to_string())?,
        id,
    )
}

fn persist(app: &tauri::AppHandle, id: &str, p: &Placement) -> Result<(), String> {
    save(
        &*app
            .state::<Database>()
            .0
            .lock()
            .map_err(|e| e.to_string())?,
        id,
        p,
    )
}

pub fn flush(app: &tauri::AppHandle) -> Result<(), String> {
    let placements = app
        .state::<Desk>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let db = app.state::<Database>();
    let mut connection = db.0.lock().map_err(|e| e.to_string())?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute("UPDATE note_windows SET is_open=0", [])
        .map_err(|e| e.to_string())?;
    for (id, p) in placements {
        save(&transaction, &id, &p)?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn apply(window: &WebviewWindow, p: &Placement) -> Result<(), String> {
    window.set_resizable(!p.folded).map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(LogicalSize::new(
            MIN_WIDTH,
            if p.folded { FOLDED_HEIGHT } else { 240.0 },
        )))
        .map_err(|e| e.to_string())?;
    window
        .set_size(LogicalSize::new(
            p.width,
            if p.folded { FOLDED_HEIGHT } else { p.height },
        ))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn attach(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let id = window
        .label()
        .strip_prefix("note-")
        .ok_or("Not a note window")?
        .to_string();
    let stored = load(
        &*app
            .state::<Database>()
            .0
            .lock()
            .map_err(|e| e.to_string())?,
        &id,
    )?;
    let mut areas = Vec::new();
    if let Some(primary) = window.primary_monitor().map_err(|e| e.to_string())? {
        areas.push(primary);
    }
    areas.extend(window.available_monitors().map_err(|e| e.to_string())?);
    let areas: Vec<_> = areas
        .iter()
        .map(|m| {
            let a = m.work_area();
            WorkArea {
                x: a.position.x,
                y: a.position.y,
                width: a.size.width,
                height: a.size.height,
                scale: m.scale_factor(),
            }
        })
        .collect();
    let mut p = fit(&stored, &areas);
    p.is_open = true;
    if crate::platform_capabilities().absolute_window_position {
        if let Some((x, y)) = p.x.zip(p.y) {
            window
                .set_position(PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        }
    }
    // Windows settles the hidden caption/shadow insets when the frameless
    // window is shown. Applying its final size earlier adds that caption height.
    #[cfg(target_os = "windows")]
    window.show().map_err(|e| e.to_string())?;
    apply(window, &p)?;
    persist(app, &id, &p)?;
    app.state::<Desk>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), p);
    let native = window.clone();
    window.on_window_event(move |event| {
        let app = native.app_handle();
        let result = (|| -> Result<(), String> {
            let state = app.state::<Desk>();
            let mut desk = state.0.lock().map_err(|e| e.to_string())?;
            let Some(p) = desk.get_mut(&id) else {
                return Ok(());
            };
            match event {
                WindowEvent::Moved(position)
                    if crate::platform_capabilities().absolute_window_position =>
                {
                    p.x = Some(position.x);
                    p.y = Some(position.y);
                }
                WindowEvent::Resized(size) if !p.folded => {
                    let scale = native.scale_factor().map_err(|e| e.to_string())?;
                    let size = size.to_logical::<f64>(scale);
                    if size.width >= MIN_WIDTH && size.height >= 240.0 {
                        p.width = size.width;
                        p.height = size.height;
                    }
                }
                WindowEvent::Focused(false) => {
                    let copy = p.clone();
                    drop(desk);
                    persist(app, &id, &copy)?;
                }
                WindowEvent::Destroyed => {
                    if !app
                        .state::<DesktopState>()
                        .exit_approved
                        .load(Ordering::SeqCst)
                    {
                        p.is_open = false;
                    }
                    let copy = p.clone();
                    desk.remove(&id);
                    drop(desk);
                    persist(app, &id, &copy)?;
                }
                _ => {}
            }
            Ok(())
        })();
        if let Err(error) = result {
            app.state::<DesktopState>()
                .errors
                .record(format!("Couldn't remember this note's window. {error}"));
        }
    });
    Ok(())
}

pub fn set_folded(window: &WebviewWindow, folded: bool) -> Result<Placement, String> {
    let app = window.app_handle();
    let id = window
        .label()
        .strip_prefix("note-")
        .ok_or("This command needs a note window")?;
    let previous = current(window)?;
    let mut next = previous.clone();
    next.folded = folded;
    // Update first so the native resize event cannot replace expanded dimensions.
    app.state::<Desk>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.into(), next.clone());
    if let Err(error) = apply(window, &next).and_then(|_| persist(app, id, &next)) {
        app.state::<Desk>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.into(), previous.clone());
        let _ = apply(window, &previous);
        return Err(error);
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standard_note_size_survives_monitor_fitting() {
        let p = fit(
            &Placement::default(),
            &[WorkArea {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
                scale: 1.5,
            }],
        );
        assert_eq!((p.width, p.height), (305.0, 385.0));
    }
    #[test]
    fn removed_monitor_returns_note_to_work_area() {
        let p = Placement {
            x: Some(-1800),
            y: Some(900),
            width: 1200.0,
            height: 1500.0,
            ..Default::default()
        };
        let p = fit(
            &p,
            &[WorkArea {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
                scale: 2.0,
            }],
        );
        assert_eq!(
            (p.x, p.y, p.width, p.height),
            (Some(0), Some(0), 960.0, 520.0)
        );
    }
    #[test]
    fn negative_monitor_and_folded_expanded_size_are_preserved() {
        let p = Placement {
            x: Some(-1000),
            y: Some(40),
            width: 400.0,
            height: 500.0,
            folded: true,
            ..Default::default()
        };
        let p = fit(
            &p,
            &[
                WorkArea {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1040,
                    scale: 1.0,
                },
                WorkArea {
                    x: -1920,
                    y: 0,
                    width: 1920,
                    height: 1040,
                    scale: 1.0,
                },
            ],
        );
        assert_eq!((p.x, p.y, p.height), (Some(-1000), Some(40), 500.0));
    }
}
