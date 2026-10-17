use crate::document::{self, SnippetPart};
use rusqlite::{Connection, MAIN_DB, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path};

const SCHEMA_VERSION: i64 = 2;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub document: Option<Value>,
    pub plain_text: String,
    pub title: String,
    pub explicit_title: String,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveNoteMetadata {
    pub id: String,
    pub title: String,
}

const MAX_NOTE_ID_LENGTH: usize = 128;

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
        migrate(&mut connection, path, version)?;
    }
    Ok(connection)
}

fn migrate(connection: &mut Connection, path: &Path, version: i64) -> Result<(), String> {
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
    if existing && version < 1 {
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
    } else if !existing {
        transaction.execute_batch("CREATE TABLE notes (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, plain_text TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'cream', revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER, search_text TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT 'Untitled note', preview TEXT NOT NULL DEFAULT '', document_error TEXT);").map_err(|error| error.to_string())?;
    }
    // Existing titles are derived metadata. Keep them and every body unchanged;
    // a new, empty field records only titles explicitly entered by the user.
    transaction
        .execute_batch("ALTER TABLE notes ADD COLUMN explicit_title TEXT NOT NULL DEFAULT '';")
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch("CREATE INDEX IF NOT EXISTS notes_recent ON notes(updated_at DESC, id);")
        .map_err(|error| error.to_string())?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn load_note(connection: &Connection, id: &str, include_trashed: bool) -> Result<Note, String> {
    connection.query_row("SELECT id, document_json, plain_text, title, preview, color, revision, updated_at, explicit_title FROM notes WHERE id=?1 AND (?2 OR trashed_at IS NULL)", params![id, include_trashed], |row| {
        let raw: String = row.get(1)?;
        let (document, document_error) = match parsed_document(&raw) {
            Ok(document) => (Some(document), None),
            Err(error) => (None, Some(error)),
        };
        Ok(Note { id: row.get(0)?, document, plain_text: row.get(2)?, title: row.get(3)?, preview: row.get(4)?, color: row.get(5)?, revision: row.get(6)?, updated_at: row.get(7)?, explicit_title: row.get(8)?, document_error })
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
    let mut statement = connection.prepare("SELECT id, title, preview, color, revision, updated_at, CASE WHEN ?2='' THEN '' ELSE plain_text END, CASE WHEN ?2='' THEN '' ELSE explicit_title END FROM notes WHERE (trashed_at IS NOT NULL)=?1 AND (?2='' OR instr(search_text, ?2)>0) AND (?3 IS NULL OR color=?3) ORDER BY updated_at DESC, id").map_err(|error| error.to_string())?;
    statement
        .query_map(params![trashed, needle, color], |row| {
            let preview: String = row.get(2)?;
            let text: String = row.get(6)?;
            let explicit_title: String = row.get(7)?;
            let snippet_text = if needle.is_empty() {
                &preview
            } else if document::search_key(&text).contains(&needle) {
                &text
            } else {
                &explicit_title
            };
            let snippet = document::snippet(snippet_text, &needle);
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

pub fn active_note_metadata(connection: &Connection) -> Result<Vec<ActiveNoteMetadata>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title FROM notes WHERE trashed_at IS NULL ORDER BY updated_at DESC, id",
        )
        .map_err(|error| error.to_string())?;
    statement
        .query_map([], |row| {
            Ok(ActiveNoteMetadata {
                id: row.get(0)?,
                title: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

fn normalized_selection<'a>(ids: &'a [&'a str]) -> Result<Vec<&'a str>, String> {
    if ids.is_empty() {
        return Err("Invalid selection".into());
    }
    let mut normalized = Vec::with_capacity(ids.len());
    for id in ids {
        if id.is_empty() || id.chars().count() > MAX_NOTE_ID_LENGTH {
            return Err("Invalid selection".into());
        }
        if !normalized.iter().any(|known| known == id) {
            normalized.push(*id);
        }
    }
    if normalized.is_empty() {
        return Err("Invalid selection".into());
    }
    Ok(normalized)
}

fn revision_for<'a>(revisions: &'a [(&'a str, i64)], id: &str) -> Option<i64> {
    revisions
        .iter()
        .find_map(|(revision_id, revision)| (*revision_id == id).then_some(*revision))
}

pub fn trash_notes_batch(
    connection: &mut Connection,
    ids: &[&str],
    revisions: &[(&str, i64)],
    timestamp: i64,
) -> Result<(), String> {
    let ids = normalized_selection(ids)?;
    if revisions
        .iter()
        .any(|(id, _)| id.is_empty() || id.chars().count() > MAX_NOTE_ID_LENGTH)
    {
        return Err("Invalid selection".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut actual_revisions = Vec::with_capacity(ids.len());
    for id in &ids {
        let actual = transaction
            .query_row(
                "SELECT revision FROM notes WHERE id=?1 AND trashed_at IS NULL",
                [*id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "A selected note no longer exists or is no longer active".to_string())?;
        actual_revisions.push(actual);
    }
    if revisions.len() != ids.len() {
        return Err("Invalid selection".into());
    }
    let mut seen_revisions = Vec::with_capacity(revisions.len());
    for (revision_id, _) in revisions {
        if seen_revisions.contains(revision_id) {
            return Err("Invalid selection".into());
        }
        seen_revisions.push(*revision_id);
    }
    for (id, actual) in ids.iter().zip(actual_revisions) {
        let Some(expected) = revision_for(revisions, id) else {
            return Err("Invalid selection".into());
        };
        if actual != expected {
            return Err("A selected note has a stale revision".into());
        }
    }
    for id in &ids {
        transaction
            .execute(
                "UPDATE notes SET trashed_at=?1 WHERE id=?2 AND trashed_at IS NULL",
                params![timestamp, *id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn purge_notes_batch(connection: &mut Connection, ids: &[&str]) -> Result<(), String> {
    let ids = normalized_selection(ids)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    for id in &ids {
        let trashed = transaction
            .query_row(
                "SELECT trashed_at IS NOT NULL FROM notes WHERE id=?1",
                [*id],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "A selected note is not in Trash".to_string())?;
        if !trashed {
            return Err("A selected note is not in Trash".into());
        }
    }
    for id in &ids {
        transaction
            .execute(
                "DELETE FROM notes WHERE id=?1 AND trashed_at IS NOT NULL",
                [*id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn insert_note(
    connection: &Connection,
    id: &str,
    document: &Value,
    color: &str,
    timestamp: i64,
    explicit_title: &str,
) -> Result<Note, String> {
    document::validate(document)?;
    validate_title(explicit_title)?;
    if !valid_color(color) {
        return Err("Invalid paper color".into());
    }
    let text = document::plain_text(document);
    let (title, preview, search_text) = note_metadata(explicit_title, &text);
    connection.execute("INSERT INTO notes (id, document_json, plain_text, color, revision, created_at, updated_at, search_text, title, preview, explicit_title) VALUES (?1,?2,?3,?4,0,?5,?5,?6,?7,?8,?9)", params![id, document.to_string(), text, color, timestamp, search_text, title, preview, explicit_title]).map_err(|error| error.to_string())?;
    load_note(connection, id, false)
}

pub fn save_document(
    connection: &mut Connection,
    id: &str,
    expected_revision: i64,
    document: &Value,
    timestamp: i64,
    explicit_title: Option<&str>,
) -> Result<Note, String> {
    document::validate(document)?;
    let text = document::plain_text(document);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let original = load_note(&transaction, id, false)?;
    if original.document_error.is_some() {
        return Err("This saved note needs recovery and cannot be overwritten.".into());
    }
    // Omitting the additive IPC field preserves a title saved by a newer caller.
    let explicit_title = explicit_title.unwrap_or(&original.explicit_title);
    validate_title(explicit_title)?;
    let (title, preview, search_text) = note_metadata(explicit_title, &text);
    let updated = transaction.execute("UPDATE notes SET document_json=?1, plain_text=?2, search_text=?3, title=?4, preview=?5, document_error=NULL, updated_at=?6, revision=revision+1, explicit_title=?9 WHERE id=?7 AND revision=?8 AND trashed_at IS NULL", params![document.to_string(), text, search_text, title, preview, timestamp, id, expected_revision, explicit_title]).map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("Stale revision or note is in Trash".into());
    }
    let note = load_note(&transaction, id, false)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(note)
}

fn validate_title(title: &str) -> Result<(), String> {
    if title.contains(['\r', '\n', '\u{2028}', '\u{2029}']) {
        return Err("A note title must be a single line.".into());
    }
    Ok(())
}

fn note_metadata(explicit_title: &str, text: &str) -> (String, String, String) {
    let (fallback, preview) = document::summary(text);
    let title = if explicit_title.trim().is_empty() {
        fallback
    } else {
        document::truncate(explicit_title.trim(), 160)
    };
    let search_text = if explicit_title.is_empty() {
        document::search_key(text)
    } else {
        document::search_key(&format!("{explicit_title}\n{text}"))
    };
    (title, preview, search_text)
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
