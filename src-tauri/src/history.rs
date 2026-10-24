use crate::{document, storage::Note};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

pub const HISTORY_LIMIT: usize = 100;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub revision: i64,
    pub saved_at: i64,
    pub title: String,
    pub preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryVersion {
    pub font_family: String,
    pub font_size: u8,
    pub revision: i64,
    pub saved_at: i64,
    pub title: String,
    pub explicit_title: String,
    pub plain_text: String,
    pub color: String,
    pub document: Value,
}

// Called in the same transaction as the replacement save. Failed/stale saves
// cannot add history, and earlier versions keep their owned image identifiers.
pub fn record(connection: &Connection, note: &Note) -> Result<(), String> {
    let document = note.document.as_ref().ok_or("This note needs recovery")?;
    connection.execute("INSERT OR IGNORE INTO note_history (note_id, revision, document_json, explicit_title, title, plain_text, color, saved_at, font_family, font_size) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![note.id,note.revision,document.to_string(),note.explicit_title,note.title,note.plain_text,note.color,note.updated_at,note.font_family,note.font_size]).map_err(|e|e.to_string())?;
    connection.execute("DELETE FROM note_history WHERE note_id=?1 AND revision NOT IN (SELECT revision FROM note_history WHERE note_id=?1 ORDER BY revision DESC LIMIT ?2)", params![note.id,HISTORY_LIMIT as i64]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn list(connection: &Connection, id: &str) -> Result<Vec<HistoryEntry>, String> {
    crate::storage::load_note(connection, id, false)?;
    let mut statement = connection.prepare("SELECT revision, saved_at, title, substr(plain_text,1,160) FROM note_history WHERE note_id=?1 ORDER BY revision DESC LIMIT ?2").map_err(|e|e.to_string())?;
    statement
        .query_map(params![id, HISTORY_LIMIT as i64], |row| {
            Ok(HistoryEntry {
                revision: row.get(0)?,
                saved_at: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn get(connection: &Connection, id: &str, revision: i64) -> Result<HistoryVersion, String> {
    crate::storage::load_note(connection, id, false)?;
    let (raw, mut version) = connection.query_row("SELECT document_json, revision, saved_at, title, explicit_title, plain_text, color, font_family, font_size FROM note_history WHERE note_id=?1 AND revision=?2",params![id,revision], |row| Ok((row.get::<_,String>(0)?, HistoryVersion { revision:row.get(1)?, saved_at:row.get(2)?, title:row.get(3)?, explicit_title:row.get(4)?, plain_text:row.get(5)?, color:row.get(6)?, font_family:row.get(7)?, font_size:row.get(8)?, document: Value::Null }))).optional().map_err(|e|e.to_string())?.ok_or("This version is no longer available")?;
    version.document =
        serde_json::from_str(&raw).map_err(|_| "This saved version could not be read")?;
    document::validate(&version.document)?;
    Ok(version)
}
