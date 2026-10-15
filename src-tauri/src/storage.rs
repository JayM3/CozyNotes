use crate::document::{self, SnippetPart};
use rusqlite::{Connection, MAIN_DB, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path};

const SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub document: Option<Value>,
    pub plain_text: String,
    pub title: String,
    pub preview: String,
    pub color: String,
    pub revision: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub color: String,
    pub revision: i64,
    pub updated_at: i64,
    pub snippet: Vec<SnippetPart>,
}

pub fn valid_color(color: &str) -> bool {
    matches!(
        color,
        "cream" | "butter" | "sage" | "rose" | "lavender" | "mist"
    )
}

fn parsed_document(raw: &str) -> Result<Value, String> {
    let value = serde_json::from_str(raw).map_err(|_| {
        "The saved document could not be read. Its original data has been preserved.".to_string()
    })?;
    document::validate(&value)?;
    Ok(value)
}

pub fn open_database(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > SCHEMA_VERSION {
        return Err("This library was created by a newer CozyNotes version. The existing data has been preserved.".into());
    }
    connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;").map_err(|error| error.to_string())?;
    if version < SCHEMA_VERSION {
        migrate(&mut connection, path)?;
    }
    Ok(connection)
}

fn migrate(connection: &mut Connection, path: &Path) -> Result<(), String> {
    let existing: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if existing {
        let data_dir = path
            .parent()
            .ok_or("The library has no parent directory.")?;
        let recovery = data_dir.parent().unwrap_or(data_dir).join("recovery");
        fs::create_dir_all(&recovery).map_err(|error| error.to_string())?;
        let snapshot = recovery.join(format!(
            "before-schema-{SCHEMA_VERSION}-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let temporary = snapshot.with_extension("sqlite.tmp");
        connection
            .backup(MAIN_DB, &temporary, None)
            .map_err(|error| error.to_string())?;
        let backup =
            Connection::open_with_flags(&temporary, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|error| error.to_string())?;
        backup
            .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
            .map_err(|error| error.to_string())?;
        let integrity: String = backup
            .pragma_query_value(None, "integrity_check", |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if integrity != "ok" {
            return Err("The pre-migration safety snapshot could not be verified.".into());
        }
        drop(backup);
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
        fs::rename(temporary, snapshot).map_err(|error| error.to_string())?;
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    if existing {
        transaction.execute_batch("ALTER TABLE notes ADD COLUMN search_text TEXT NOT NULL DEFAULT ''; ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled note'; ALTER TABLE notes ADD COLUMN preview TEXT NOT NULL DEFAULT ''; ALTER TABLE notes ADD COLUMN document_error TEXT;").map_err(|error| error.to_string())?;
        let rows = {
            let mut statement = transaction
                .prepare("SELECT id, document_json, plain_text FROM notes")
                .map_err(|error| error.to_string())?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?
        };
        for (id, raw, previous_text) in rows {
            let (text, error) = match parsed_document(&raw) {
                Ok(document) => (document::plain_text(&document), None),
                Err(error) => (previous_text, Some(error)),
            };
            let (title, preview) = document::summary(&text);
            transaction.execute("UPDATE notes SET plain_text=?1, search_text=?2, title=?3, preview=?4, document_error=?5 WHERE id=?6", params![text, document::search_key(&text), title, preview, error, id]).map_err(|error| error.to_string())?;
        }
    } else {
        transaction.execute_batch("CREATE TABLE notes (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, plain_text TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'cream', revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER, search_text TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT 'Untitled note', preview TEXT NOT NULL DEFAULT '', document_error TEXT);").map_err(|error| error.to_string())?;
    }
    transaction
        .execute_batch(
            "CREATE INDEX notes_recent ON notes(updated_at DESC, id); PRAGMA user_version=1;",
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn load_note(connection: &Connection, id: &str, include_trashed: bool) -> Result<Note, String> {
    connection.query_row("SELECT id, document_json, plain_text, title, preview, color, revision, updated_at FROM notes WHERE id=?1 AND (?2 OR trashed_at IS NULL)", params![id, include_trashed], |row| {
        let raw: String = row.get(1)?;
        let (document, document_error) = match parsed_document(&raw) {
            Ok(document) => (Some(document), None),
            Err(error) => (None, Some(error)),
        };
        Ok(Note { id: row.get(0)?, document, plain_text: row.get(2)?, title: row.get(3)?, preview: row.get(4)?, color: row.get(5)?, revision: row.get(6)?, updated_at: row.get(7)?, document_error })
    }).optional().map_err(|error| error.to_string())?.ok_or_else(|| "Note not found".into())
}

pub fn list_notes(
    connection: &Connection,
    trashed: bool,
    query: &str,
    color: Option<&str>,
) -> Result<Vec<NoteSummary>, String> {
    if color.is_some_and(|color| !valid_color(color)) {
        return Err("Invalid paper color".into());
    }
    let needle = document::search_key(query.trim());
    let mut statement = connection.prepare("SELECT id, title, preview, color, revision, updated_at, CASE WHEN ?2='' THEN '' ELSE plain_text END FROM notes WHERE (trashed_at IS NOT NULL)=?1 AND (?2='' OR instr(search_text, ?2)>0) AND (?3 IS NULL OR color=?3) ORDER BY updated_at DESC, id").map_err(|error| error.to_string())?;
    statement
        .query_map(params![trashed, needle, color], |row| {
            let preview: String = row.get(2)?;
            let text: String = row.get(6)?;
            let snippet =
                document::snippet(if needle.is_empty() { &preview } else { &text }, &needle);
            Ok(NoteSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                preview,
                color: row.get(3)?,
                revision: row.get(4)?,
                updated_at: row.get(5)?,
                snippet,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub fn insert_note(
    connection: &Connection,
    id: &str,
    document: &Value,
    color: &str,
    timestamp: i64,
) -> Result<Note, String> {
    document::validate(document)?;
    if !valid_color(color) {
        return Err("Invalid paper color".into());
    }
    let text = document::plain_text(document);
    let (title, preview) = document::summary(&text);
    connection.execute("INSERT INTO notes (id, document_json, plain_text, color, revision, created_at, updated_at, search_text, title, preview) VALUES (?1,?2,?3,?4,0,?5,?5,?6,?7,?8)", params![id, document.to_string(), text, color, timestamp, document::search_key(&text), title, preview]).map_err(|error| error.to_string())?;
    load_note(connection, id, false)
}

pub fn save_document(
    connection: &mut Connection,
    id: &str,
    expected_revision: i64,
    document: &Value,
    timestamp: i64,
) -> Result<Note, String> {
    document::validate(document)?;
    let text = document::plain_text(document);
    let (title, preview) = document::summary(&text);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let original = load_note(&transaction, id, false)?;
    if original.document_error.is_some() {
        return Err("This saved note needs recovery and cannot be overwritten.".into());
    }
    let updated = transaction.execute("UPDATE notes SET document_json=?1, plain_text=?2, search_text=?3, title=?4, preview=?5, document_error=NULL, updated_at=?6, revision=revision+1 WHERE id=?7 AND revision=?8 AND trashed_at IS NULL", params![document.to_string(), text, document::search_key(&text), title, preview, timestamp, id, expected_revision]).map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("Stale revision or note is in Trash".into());
    }
    let note = load_note(&transaction, id, false)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(note)
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
