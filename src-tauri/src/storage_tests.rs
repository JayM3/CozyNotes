use super::*;
use serde_json::json;
use std::{path::PathBuf, time::Instant};
use unicode_segmentation::UnicodeSegmentation;

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("cozynotes-backend-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data")).unwrap();
        Self(root)
    }

    fn database(&self) -> PathBuf {
        self.0.join("data/cozynotes.sqlite")
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn doc(text: &str) -> Value {
    if text.is_empty() {
        json!({"type":"doc","content":[{"type":"paragraph"}]})
    } else {
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
    }
}

#[test]
fn schema_two_upgrade_preserves_notes_and_creates_a_verified_snapshot() {
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    insert_note(
        &connection,
        "existing",
        &doc("Keep this body"),
        "sage",
        22,
        "My title",
    )
    .unwrap();
    connection.execute_batch("DROP TABLE note_history; DROP TABLE note_windows; ALTER TABLE notes DROP COLUMN favorite; PRAGMA user_version=2;").unwrap();
    drop(connection);
    let connection = open_database(&root.database()).unwrap();
    let note = load_note(&connection, "existing", false).unwrap();
    assert_eq!(note.explicit_title, "My title");
    assert_eq!(note.document, Some(doc("Keep this body")));
    assert_eq!(
        (note.revision, note.updated_at, note.favorite),
        (0, 22, false)
    );
    assert!(
        crate::history::list(&connection, "existing")
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read_dir(root.0.join("recovery")).unwrap().count(), 1);
    drop(connection);
    open_database(&root.database()).unwrap(); // Migration is not rerun.
}

#[test]
fn favorites_rank_before_recent_notes_without_changing_edit_metadata() {
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "old", &doc("Old"), "sage", 1, "").unwrap();
    insert_note(&connection, "new", &doc("New"), "cream", 99, "").unwrap();
    connection
        .execute("UPDATE notes SET favorite=1 WHERE id='old'", [])
        .unwrap();
    let notes = list_notes(&connection, false, "", None).unwrap();
    assert_eq!(
        notes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        vec!["old", "new"]
    );
    assert_eq!(
        (notes[0].revision, notes[0].updated_at, notes[0].favorite),
        (0, 1, true)
    );
    assert_eq!(
        list_notes(&connection, false, "New", None).unwrap()[0].id,
        "new"
    );
    assert_eq!(
        list_notes(&connection, false, "", Some("cream")).unwrap()[0].id,
        "new"
    );
}

#[test]
fn history_is_atomic_retains_images_and_survives_restart() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    let image = serde_json::json!({"type":"doc","content":[{"type":"image","attrs":{"assetId":"12345678-1234-1234-1234-123456789abc.png","alt":"A picture"}}]});
    insert_note(&connection, "note", &image, "rose", 12, "Before").unwrap();
    save_document(
        &mut connection,
        "note",
        0,
        &doc("After"),
        20,
        Some("After title"),
    )
    .unwrap();
    let version = crate::history::get(&connection, "note", 0).unwrap();
    assert_eq!(version.document, image);
    assert_eq!(
        (
            version.explicit_title.as_str(),
            version.color.as_str(),
            version.saved_at
        ),
        ("Before", "rose", 12)
    );
    assert!(save_document(&mut connection, "note", 0, &doc("Stale"), 30, None).is_err());
    assert_eq!(crate::history::list(&connection, "note").unwrap().len(), 1);
    connection.execute_batch("CREATE TRIGGER fail_save BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'write failed'); END;").unwrap();
    assert!(save_document(&mut connection, "note", 1, &doc("Failed"), 30, None).is_err());
    assert_eq!(crate::history::list(&connection, "note").unwrap().len(), 1);
    drop(connection);
    let connection = open_database(&root.database()).unwrap();
    assert_eq!(
        crate::history::get(&connection, "note", 0)
            .unwrap()
            .document,
        image
    );
    assert_eq!(
        load_note(&connection, "note", false).unwrap().document,
        Some(doc("After"))
    );
}

#[test]
fn history_skips_unchanged_saves_is_bounded_and_follows_permanent_deletion() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "note", &doc("Same"), "cream", 1, "").unwrap();
    assert_eq!(
        save_document(&mut connection, "note", 0, &doc("Same"), 2, None)
            .unwrap()
            .revision,
        0
    );
    assert!(
        crate::history::list(&connection, "note")
            .unwrap()
            .is_empty()
    );
    for revision in 0..105 {
        save_document(
            &mut connection,
            "note",
            revision,
            &doc(&format!("Change {revision}")),
            revision + 10,
            None,
        )
        .unwrap();
    }
    let entries = crate::history::list(&connection, "note").unwrap();
    assert_eq!(entries.len(), 100);
    assert_eq!(
        (
            entries.first().unwrap().revision,
            entries.last().unwrap().revision
        ),
        (104, 5)
    );
    assert!(crate::history::get(&connection, "note", 0).is_err());
    connection
        .execute("UPDATE notes SET trashed_at=1 WHERE id='note'", [])
        .unwrap();
    purge_notes_batch(&mut connection, &["note"]).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM note_history", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn desk_round_trips_expanded_size_folded_state_and_open_set() {
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    for id in ["open", "closed", "trashed"] {
        insert_note(&connection, id, &doc(id), "cream", 1, "").unwrap();
    }
    let p = crate::desk::Placement {
        width: 480.0,
        height: 620.0,
        x: Some(-700),
        y: Some(90),
        folded: true,
        is_open: true,
    };
    crate::desk::save(&connection, "open", &p).unwrap();
    crate::desk::save(
        &connection,
        "closed",
        &crate::desk::Placement {
            is_open: false,
            ..p.clone()
        },
    )
    .unwrap();
    crate::desk::save(&connection, "trashed", &p).unwrap();
    connection
        .execute("UPDATE notes SET trashed_at=1 WHERE id='trashed'", [])
        .unwrap();
    drop(connection);
    let connection = open_database(&root.database()).unwrap();
    assert_eq!(crate::desk::open_ids(&connection).unwrap(), vec!["open"]);
    let restored = crate::desk::load(&connection, "open").unwrap();
    assert_eq!(
        (
            restored.width,
            restored.height,
            restored.x,
            restored.y,
            restored.folded
        ),
        (480.0, 620.0, Some(-700), Some(90), true)
    );
    connection
        .execute("DELETE FROM notes WHERE id='open'", [])
        .unwrap();
    assert!(crate::desk::open_ids(&connection).unwrap().is_empty());
}

fn legacy_database(path: &Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE notes (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, plain_text TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'cream', revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER);").unwrap();
    connection
}

fn legacy_insert(connection: &Connection, id: &str, raw: &str, text: &str) {
    connection.execute("INSERT INTO notes (id, document_json, plain_text, color, revision, created_at, updated_at) VALUES (?1,?2,?3,'sage',7,11,22)", params![id, raw, text]).unwrap();
}

#[test]
fn schema_one_adds_empty_titles_without_rewriting_existing_notes() {
    let root = TestRoot::new();
    let previous = legacy_database(&root.database());
    previous.execute_batch("ALTER TABLE notes ADD COLUMN search_text TEXT NOT NULL DEFAULT ''; ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled note'; ALTER TABLE notes ADD COLUMN preview TEXT NOT NULL DEFAULT ''; ALTER TABLE notes ADD COLUMN document_error TEXT; CREATE INDEX notes_recent ON notes(updated_at DESC, id); PRAGMA user_version=1;").unwrap();
    let raw = "{ \"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Original first line\"}]}] }";
    legacy_insert(&previous, "old", raw, "Original first line\n");
    legacy_insert(&previous, "recovery", "{truncated", "recoverable text");
    previous.execute_batch("UPDATE notes SET title='Original first line', preview='Original first line', search_text='original first line\n' WHERE id='old'; UPDATE notes SET trashed_at=33, document_error='Unreadable' WHERE id='recovery';").unwrap();
    let rows = |connection: &Connection| {
        let mut statement = connection.prepare("SELECT id, document_json, plain_text, color, revision, created_at, updated_at, trashed_at, search_text, title, preview, document_error FROM notes ORDER BY id").unwrap();
        statement
            .query_map([], |row| {
                (0..12)
                    .map(|column| row.get::<_, rusqlite::types::Value>(column))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let before = rows(&previous);
    let connection = open_database(&root.database()).unwrap();
    assert_eq!(rows(&connection), before);
    assert_eq!(
        load_note(&connection, "old", false).unwrap().explicit_title,
        ""
    );
    assert_eq!(
        load_note(&connection, "recovery", true)
            .unwrap()
            .explicit_title,
        ""
    );
    assert_eq!(
        list_notes(&connection, false, "ORIGINAL", None)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    let snapshots = fs::read_dir(root.0.join("recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(snapshots.len(), 1);
    let snapshot = Connection::open(&snapshots[0]).unwrap();
    assert_eq!(rows(&snapshot), before);
    assert_eq!(
        snapshot
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(connection);
    let reopened = open_database(&root.database()).unwrap();
    assert_eq!(rows(&reopened), before);
    assert_eq!(fs::read_dir(root.0.join("recovery")).unwrap().count(), 1);
}

#[test]
fn title_and_body_save_atomically_and_preserve_omitted_titles() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("Original body"), "sage", 1, "").unwrap();
    let saved = save_document(
        &mut connection,
        "one",
        0,
        &doc("Updated body"),
        2,
        Some("Packing list"),
    )
    .unwrap();
    assert_eq!(
        (
            saved.explicit_title.as_str(),
            saved.title.as_str(),
            saved.revision
        ),
        ("Packing list", "Packing list", 1)
    );
    assert_eq!(saved.preview, "Updated body");
    assert!(
        save_document(
            &mut connection,
            "one",
            0,
            &doc("Stale body"),
            3,
            Some("Stale title")
        )
        .is_err()
    );
    assert!(
        save_document(
            &mut connection,
            "one",
            1,
            &doc("Rejected body"),
            3,
            Some("Invalid\ntitle")
        )
        .is_err()
    );
    let unchanged = load_note(&connection, "one", false).unwrap();
    assert_eq!(unchanged.document, Some(doc("Updated body")));
    assert_eq!(unchanged.explicit_title, "Packing list");
    assert_eq!((unchanged.revision, unchanged.updated_at), (1, 2));
    let saved = save_document(
        &mut connection,
        "one",
        1,
        &doc("Body from older caller"),
        4,
        None,
    )
    .unwrap();
    assert_eq!(saved.explicit_title, "Packing list");
    assert_eq!(
        active_note_metadata(&connection).unwrap()[0].title,
        "Packing list"
    );
    drop(connection);
    let mut connection = open_database(&root.database()).unwrap();
    assert_eq!(
        load_note(&connection, "one", false).unwrap().explicit_title,
        "Packing list"
    );
    let cleared = save_document(
        &mut connection,
        "one",
        2,
        &doc("Body fallback"),
        5,
        Some(""),
    )
    .unwrap();
    assert_eq!(cleared.title, "Body fallback");
    assert_eq!(cleared.explicit_title, "");
    assert!(
        list_notes(&connection, false, "Packing", None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn title_and_body_search_support_unicode_trash_and_title_only_notes() {
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    insert_note(
        &connection,
        "one",
        &doc("Bring passport"),
        "sage",
        1,
        "Straße Café",
    )
    .unwrap();
    insert_note(&connection, "title-only", &doc(""), "cream", 2, "Weekend").unwrap();
    for query in ["STRASSE", "CAFE\u{301}", "passport"] {
        let results = list_notes(&connection, false, query, Some("sage")).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "one");
        assert!(results[0].snippet.iter().any(|part| part.matched));
    }
    let title_only = list_notes(&connection, false, "weekend", None).unwrap();
    assert_eq!(title_only.len(), 1);
    assert_eq!(title_only[0].title, "Weekend");
    assert!(title_only[0].snippet.iter().any(|part| part.matched));
    connection
        .execute("UPDATE notes SET trashed_at=3 WHERE id='one'", [])
        .unwrap();
    assert!(
        list_notes(&connection, false, "STRASSE", None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        list_notes(&connection, true, "STRASSE", Some("sage"))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn copying_a_note_preserves_its_explicit_title_body_and_color() {
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    let source = insert_note(
        &connection,
        "source",
        &doc("Keep my body"),
        "rose",
        1,
        "My heading",
    )
    .unwrap();
    let copy = insert_note(
        &connection,
        "copy",
        source.document.as_ref().unwrap(),
        &source.color,
        2,
        &source.explicit_title,
    )
    .unwrap();
    assert_eq!(copy.document, source.document);
    assert_eq!(copy.explicit_title, source.explicit_title);
    assert_eq!(copy.title, source.title);
    assert_eq!(copy.color, source.color);
    assert_eq!(copy.revision, 0);
}

#[test]
fn persistence_and_stale_revisions_are_atomic() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    let note = insert_note(&connection, "one", &doc("before"), "cream", 10, "").unwrap();
    assert_eq!(note.revision, 0);
    let saved = save_document(&mut connection, "one", 0, &doc("after"), 20, None).unwrap();
    assert_eq!((saved.revision, saved.updated_at), (1, 20));
    assert!(
        save_document(&mut connection, "one", 0, &doc("stale"), 30, None)
            .unwrap_err()
            .contains("Stale")
    );
    drop(connection);
    let connection = open_database(&root.database()).unwrap();
    let saved = load_note(&connection, "one", false).unwrap();
    assert_eq!(saved.document, Some(doc("after")));
    assert_eq!((saved.revision, saved.updated_at), (1, 20));
    assert_eq!(
        fs::read_dir(root.0.join("recovery"))
            .map(|entries| entries.count())
            .unwrap_or(0),
        0
    );
}

#[test]
fn migration_preserves_raw_documents_and_metadata_with_wal_snapshot() {
    let root = TestRoot::new();
    let previous = legacy_database(&root.database());
    let raw = "{ \"type\":\"doc\", \"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Stra\\u00dfe\"},{\"type\":\"hardBreak\"},{\"type\":\"text\",\"text\":\"second\"}]}]}";
    legacy_insert(&previous, "good", raw, "old text");
    legacy_insert(&previous, "bad", "{truncated", "recoverable text");
    previous
        .execute("UPDATE notes SET trashed_at=33 WHERE id='bad'", [])
        .unwrap();
    let connection = open_database(&root.database()).unwrap();
    let current_raw: String = connection
        .query_row(
            "SELECT document_json FROM notes WHERE id='good'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(current_raw, raw);
    let good = load_note(&connection, "good", false).unwrap();
    assert_eq!(good.plain_text, "Stra\u{df}e\nsecond\n");
    assert_eq!(
        (good.color.as_str(), good.revision, good.updated_at),
        ("sage", 7, 22)
    );
    let preserved: (String, String, i64, i64, i64, i64) = connection.query_row("SELECT document_json, plain_text, revision, created_at, updated_at, trashed_at FROM notes WHERE id='bad'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).unwrap();
    assert_eq!(
        preserved,
        (
            "{truncated".into(),
            "recoverable text".into(),
            7,
            11,
            22,
            33
        )
    );
    assert_eq!(
        list_notes(&connection, false, "STRASSE", None)
            .unwrap()
            .len(),
        1
    );
    assert!(
        load_note(&connection, "bad", true)
            .unwrap()
            .document_error
            .is_some()
    );
    let snapshots = fs::read_dir(root.0.join("recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(snapshots.len(), 1);
    let backup = Connection::open(&snapshots[0]).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        backup
            .query_row("SELECT plain_text FROM notes WHERE id='good'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "old text"
    );
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM notes", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn failed_migration_rolls_back_schema_and_data() {
    let root = TestRoot::new();
    let connection = legacy_database(&root.database());
    legacy_insert(
        &connection,
        "one",
        &doc("unchanged").to_string(),
        "unchanged",
    );
    connection.execute_batch("CREATE TRIGGER reject_backfill BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    drop(connection);
    assert!(
        open_database(&root.database())
            .unwrap_err()
            .contains("injected failure")
    );
    let connection = Connection::open(root.database()).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(connection.prepare("SELECT search_text FROM notes").is_err());
    assert_eq!(
        connection
            .query_row("SELECT plain_text FROM notes", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "unchanged"
    );
    assert_eq!(fs::read_dir(root.0.join("recovery")).unwrap().count(), 1);
}

#[test]
fn newer_database_is_rejected_without_schema_changes() {
    let root = TestRoot::new();
    let connection = legacy_database(&root.database());
    legacy_insert(&connection, "one", &doc("newer").to_string(), "newer");
    connection.pragma_update(None, "user_version", 9).unwrap();
    drop(connection);
    assert!(
        open_database(&root.database())
            .unwrap_err()
            .contains("newer")
    );
    let connection = Connection::open(root.database()).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert!(connection.prepare("SELECT search_text FROM notes").is_err());
}

#[test]
fn unreadable_or_unsupported_notes_remain_readable_but_cannot_be_overwritten() {
    let root = TestRoot::new();
    let previous = legacy_database(&root.database());
    for (id, raw) in [
        ("bad", "{invalid"),
        (
            "future",
            r#"{"type":"doc","content":[{"type":"futureImage"}]}"#,
        ),
    ] {
        legacy_insert(&previous, id, raw, "original metadata");
    }
    drop(previous);
    let mut connection = open_database(&root.database()).unwrap();
    for (id, raw) in [
        ("bad", "{invalid"),
        (
            "future",
            r#"{"type":"doc","content":[{"type":"futureImage"}]}"#,
        ),
    ] {
        let note = load_note(&connection, id, false).unwrap();
        assert!(note.document.is_none());
        assert!(note.document_error.is_some());
        assert_eq!(note.plain_text, "original metadata");
        let json = serde_json::to_value(&note).unwrap();
        assert!(json["document"].is_null());
        assert!(
            save_document(&mut connection, id, 7, &doc("replacement"), 100, None)
                .unwrap_err()
                .contains("cannot be overwritten")
        );
        assert_eq!(
            connection
                .query_row("SELECT document_json FROM notes WHERE id=?1", [id], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            raw
        );
    }
    assert_eq!(
        list_notes(&connection, false, "metadata", None)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn document_validation_keeps_all_previously_configured_starterkit_nodes_and_marks() {
    let document = json!({"type":"doc","content":[
        {"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"heading","marks":[{"type":"bold"},{"type":"italic"},{"type":"underline"},{"type":"strike"},{"type":"link","attrs":{"href":"https://example.invalid","rel":"nofollow","target":"_blank","class":null,"title":"link"}}]}]},
        {"type":"paragraph","content":[{"type":"text","text":"inline","marks":[{"type":"code"}]},{"type":"hardBreak","marks":[{"type":"bold"}]}]},
        {"type":"blockquote","content":[{"type":"paragraph"}]},
        {"type":"codeBlock","attrs":{"language":"rust"},"content":[{"type":"text","text":"fn main() {}"}]},
        {"type":"horizontalRule"},
        {"type":"orderedList","attrs":{"start":5,"type":"a"},"content":[{"type":"listItem","content":[{"type":"paragraph"},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph"}]}]}]}]},
        {"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph"},{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph"}]}]}]}]}
    ]});
    document::validate(&document).unwrap();
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "rich", &document, "mist", 1, "").unwrap();
    assert_eq!(
        load_note(&connection, "rich", false).unwrap().document,
        Some(document)
    );
}

#[test]
fn image_blocks_validate_and_are_represented_in_recovery_text() {
    let document = json!({"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"Before"}]},
        {"type":"image","attrs":{"assetId":"550e8400-e29b-41d4-a716-446655440000.png","alt":"Screenshot"}},
        {"type":"paragraph","content":[{"type":"text","text":"After"}]}
    ]});
    document::validate(&document).unwrap();
    assert_eq!(document::plain_text(&document), "Before\n[Image]\nAfter\n");

    for invalid in [
        json!({"type":"doc","content":[{"type":"image","attrs":{"assetId":"../../outside.png"}}]}),
        json!({"type":"doc","content":[{"type":"image","attrs":{"assetId":"550e8400-e29b-41d4-a716-446655440000.png","unknown":true}}]}),
    ] {
        assert!(document::validate(&invalid).is_err());
    }
}

#[test]
fn invalid_saves_never_modify_existing_rows() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("original"), "cream", 5, "").unwrap();
    for invalid in [
        json!({"type":"doc","content":[]}),
        json!({"type":"doc","content":[{"type":"text","text":"wrong parent"}]}),
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"bad mark","marks":[{"type":"future"}]}]}]}),
        json!({"type":"doc","content":[{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":"true"},"content":[{"type":"paragraph"}]}]}]}),
        json!({"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"marked code","marks":[{"type":"bold"}]}]}]}),
    ] {
        assert!(save_document(&mut connection, "one", 0, &invalid, 100, None).is_err());
        let original = load_note(&connection, "one", false).unwrap();
        assert_eq!((original.revision, original.updated_at), (0, 5));
        assert_eq!(original.document, Some(doc("original")));
    }
}

fn ink_document() -> Value {
    json!({"type":"doc","content":[{"type":"ink","attrs":{
        "version":1,"width":600,"height":400,"description":"A blue flower","strokes":[
            {"color":"#315e9e","width":4,"points":[
                {"x":0.25,"y":0.5,"pressure":0.3,"tiltX":-30,"tiltY":15},
                {"x":0.75,"y":0.6,"pressure":0.9,"tiltX":20,"tiltY":-10}
            ]}
        ]
    }},{"type":"paragraph"}]})
}

#[test]
fn ink_survives_saving_history_copying_trash_and_restart() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    let drawing = ink_document();
    let note = insert_note(&connection, "ink", &drawing, "sage", 1, "Sketch").unwrap();
    assert_eq!(note.plain_text, "[Ink: A blue flower]\n\n");
    assert_eq!(
        list_notes(&connection, false, "flower", None)
            .unwrap()
            .len(),
        1
    );
    let mut erased = drawing.clone();
    erased["content"][0]["attrs"]["strokes"] = json!([]);
    save_document(&mut connection, "ink", 0, &erased, 2, None).unwrap();
    let version = crate::history::get(&connection, "ink", 0).unwrap();
    assert_eq!(version.document, drawing);
    insert_note(
        &connection,
        "restored",
        &version.document,
        "sage",
        3,
        "Restored",
    )
    .unwrap();
    insert_note(&connection, "copy", &erased, "sage", 3, "Copy").unwrap();
    connection
        .execute("UPDATE notes SET trashed_at=4 WHERE id='restored'", [])
        .unwrap();
    assert!(load_note(&connection, "restored", false).is_err());
    assert_eq!(
        load_note(&connection, "restored", true).unwrap().document,
        Some(drawing.clone())
    );
    connection
        .execute("UPDATE notes SET trashed_at=NULL WHERE id='restored'", [])
        .unwrap();
    drop(connection);
    let connection = open_database(&root.database()).unwrap();
    assert_eq!(
        load_note(&connection, "restored", false).unwrap().document,
        Some(drawing)
    );
    assert_eq!(
        load_note(&connection, "copy", false).unwrap().document,
        Some(erased)
    );
}

#[test]
fn invalid_ink_and_aggregate_limits_cannot_overwrite_notes_or_add_history() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "note", &doc("Original"), "cream", 1, "").unwrap();
    let mut invalid = ink_document();
    invalid["content"][0]["attrs"]["strokes"][0]["points"][0]["pressure"] = json!(1.1);
    assert!(save_document(&mut connection, "note", 0, &invalid, 2, None).is_err());
    let mut missing = ink_document();
    missing["content"][0]
        .as_object_mut()
        .unwrap()
        .remove("attrs");
    assert!(document::validate(&missing).is_err());
    let ink = &ink_document()["content"][0];
    let too_many =
        json!({"type":"doc","content":vec![ink.clone(); crate::ink::MAX_INK_DRAWINGS + 1]});
    assert!(document::validate(&too_many).is_err());
    let mut large = ink.clone();
    let point = large["attrs"]["strokes"][0]["points"][0].clone();
    large["attrs"]["strokes"][0]["points"] = json!(vec![point; 8192]);
    large["attrs"]["strokes"] = json!(vec![large["attrs"]["strokes"][0].clone(); 6]);
    let aggregate = json!({"type":"doc","content":[
        large.clone(), {"type":"blockquote","content":[large.clone(), large]}
    ]});
    assert!(document::validate(&aggregate).is_err());
    assert!(
        crate::history::list(&connection, "note")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        load_note(&connection, "note", false).unwrap().document,
        Some(doc("Original"))
    );
}

#[test]
fn hard_breaks_and_blocks_remain_separate_in_text_and_titles() {
    let document = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"alpha"},{"type":"hardBreak"},{"type":"text","text":"beta"}]},{"type":"codeBlock","content":[{"type":"text","text":"gamma"}]},{"type":"paragraph","content":[{"type":"text","text":"delta"}]}]});
    document::validate(&document).unwrap();
    assert_eq!(
        document::plain_text(&document),
        "alpha\nbeta\ngamma\ndelta\n"
    );
    assert_eq!(
        document::summary(&document::plain_text(&document)).0,
        "alpha"
    );
}

#[test]
fn unicode_search_and_first_match_excerpts_preserve_original_graphemes() {
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    let text = format!(
        "{} Stra\u{df}e CAF\u{c9} cafe\u{301} \u{3a3}\u{3c2}\u{3c3} family \u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466} suffix",
        "prefix ".repeat(30)
    );
    insert_note(&connection, "unicode", &doc(&text), "sage", 1, "").unwrap();
    for query in [
        "STRASSE",
        "caf\u{e9}",
        "CAFE\u{301}",
        "\u{3c3}\u{3c3}\u{3c3}",
        "\u{1f467}",
    ] {
        let notes = list_notes(&connection, false, query, None).unwrap();
        assert_eq!(notes.len(), 1, "query: {query}");
        assert!(notes[0].snippet.iter().any(|part| part.matched));
        assert!(
            notes[0]
                .snippet
                .iter()
                .map(|part| part.text.graphemes(true).count())
                .sum::<usize>()
                <= 166
        );
    }
    let notes = list_notes(&connection, false, "STRASSE", None).unwrap();
    assert_eq!(
        notes[0]
            .snippet
            .iter()
            .find(|part| part.matched)
            .unwrap()
            .text,
        "Stra\u{df}e"
    );
    let family = list_notes(&connection, false, "\u{1f467}", None).unwrap();
    assert_eq!(
        family[0]
            .snippet
            .iter()
            .find(|part| part.matched)
            .unwrap()
            .text,
        "\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}"
    );
    let accent = document::snippet(
        "before cafe\u{301} after",
        &document::search_key("CAF\u{c9}"),
    );
    assert_eq!(
        accent.iter().find(|part| part.matched).unwrap().text,
        "cafe\u{301}"
    );
}

#[test]
fn color_and_trash_filters_compose_and_summaries_have_no_full_bodies() {
    let root = TestRoot::new();
    let connection = open_database(&root.database()).unwrap();
    for (id, color, time) in [
        ("rose", "rose", 1),
        ("sage", "sage", 2),
        ("trashed", "rose", 3),
    ] {
        insert_note(
            &connection,
            id,
            &doc("shared title\nsecond line text"),
            color,
            time,
            "",
        )
        .unwrap();
    }
    connection
        .execute("UPDATE notes SET trashed_at=5 WHERE id='trashed'", [])
        .unwrap();
    let all = list_notes(&connection, false, "", None).unwrap();
    assert_eq!(
        all.iter().map(|note| note.id.as_str()).collect::<Vec<_>>(),
        ["sage", "rose"]
    );
    assert_eq!(
        list_notes(&connection, false, "SHARED", Some("rose")).unwrap()[0].id,
        "rose"
    );
    assert_eq!(
        list_notes(&connection, true, "shared", Some("rose")).unwrap()[0].id,
        "trashed"
    );
    assert!(
        list_notes(&connection, true, "shared", Some("sage"))
            .unwrap()
            .is_empty()
    );
    assert!(list_notes(&connection, false, "", Some("unknown")).is_err());
    let serialized = serde_json::to_value(all).unwrap();
    assert!(serialized[0].get("document").is_none());
    assert!(serialized[0].get("plainText").is_none());
    assert!(serialized[0]["snippet"].is_array());
}

#[test]
fn excerpts_do_not_interpret_html_or_expand_to_an_entire_long_match() {
    let text = format!("<script>alert(1)</script> {}", "x".repeat(500));
    let snippet = document::snippet(&text, &document::search_key(&text));
    let combined = snippet
        .iter()
        .map(|part| part.text.as_str())
        .collect::<String>();
    assert!(combined.starts_with("<script>"));
    assert!(combined.graphemes(true).count() <= 163);
    let summary = document::summary(&text);
    assert_eq!(summary.0.graphemes(true).count(), 160);
    assert_eq!(summary.1.graphemes(true).count(), 120);
    let crlf = document::snippet("\r\nX\r\n", "x\r");
    assert_eq!(crlf.iter().find(|part| part.matched).unwrap().text, "X\r\n");
}

#[test]
fn trashed_notes_cannot_be_saved_or_accidentally_restored_by_save() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("original"), "cream", 1, "").unwrap();
    connection
        .execute("UPDATE notes SET trashed_at=5 WHERE id='one'", [])
        .unwrap();
    assert!(save_document(&mut connection, "one", 0, &doc("replacement"), 10, None).is_err());
    assert_eq!(
        load_note(&connection, "one", true).unwrap().document,
        Some(doc("original"))
    );
    assert!(load_note(&connection, "one", false).is_err());
}

#[test]
fn batch_trash_deduplicates_and_requires_current_active_revisions_atomically() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("one"), "cream", 1, "").unwrap();
    insert_note(&connection, "two", &doc("two"), "sage", 2, "").unwrap();
    insert_note(&connection, "three", &doc("three"), "rose", 3, "").unwrap();

    trash_notes_batch(
        &mut connection,
        &["one", "one", "two"],
        &[("one", 0), ("two", 0)],
        10,
    )
    .unwrap();

    assert!(load_note(&connection, "one", false).is_err());
    assert!(load_note(&connection, "two", false).is_err());
    assert!(load_note(&connection, "three", false).is_ok());
}

#[test]
fn batch_trash_rejects_missing_trashed_or_stale_rows_without_partial_mutation() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("one"), "cream", 1, "").unwrap();
    insert_note(&connection, "two", &doc("two"), "sage", 2, "").unwrap();
    connection
        .execute("UPDATE notes SET trashed_at=5 WHERE id='two'", [])
        .unwrap();

    for (ids, revisions, expected) in [
        (vec!["one", "missing"], vec![("one", 0)], "no longer exists"),
        (
            vec!["one", "two"],
            vec![("one", 0), ("two", 0)],
            "no longer active",
        ),
        (vec!["one"], vec![("one", 9)], "revision"),
    ] {
        let error = trash_notes_batch(&mut connection, &ids, &revisions, 10).unwrap_err();
        assert!(
            error.to_lowercase().contains(&expected.to_lowercase()),
            "{error}"
        );
        assert!(load_note(&connection, "one", false).is_ok());
        assert!(load_note(&connection, "two", true).is_ok());
    }
}

#[test]
fn batch_purge_requires_every_row_to_be_trashed_and_rolls_back_on_invalid_selection() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("one"), "cream", 1, "").unwrap();
    insert_note(&connection, "two", &doc("two"), "sage", 2, "").unwrap();
    connection
        .execute("UPDATE notes SET trashed_at=5 WHERE id='one'", [])
        .unwrap();

    let error = purge_notes_batch(&mut connection, &["one", "one", "two"]).unwrap_err();
    assert!(error.contains("not in Trash"));
    assert!(load_note(&connection, "one", true).is_ok());
    assert!(load_note(&connection, "two", false).is_ok());

    connection
        .execute("UPDATE notes SET trashed_at=6 WHERE id='two'", [])
        .unwrap();
    purge_notes_batch(&mut connection, &["one", "one", "two"]).unwrap();
    assert!(load_note(&connection, "one", true).is_err());
    assert!(load_note(&connection, "two", true).is_err());
}

#[test]
fn batch_trash_supports_selections_larger_than_one_hundred_twenty_eight() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    let ids = (0..129)
        .map(|index| format!("note-{index}"))
        .collect::<Vec<_>>();
    for (index, id) in ids.iter().enumerate() {
        insert_note(&connection, id, &doc(id), "cream", index as i64, "").unwrap();
    }
    let borrowed_ids = ids.iter().map(String::as_str).collect::<Vec<_>>();
    let revisions = ids.iter().map(|id| (id.as_str(), 0)).collect::<Vec<_>>();

    trash_notes_batch(&mut connection, &borrowed_ids, &revisions, 200).unwrap();

    assert!(
        ids.iter()
            .all(|id| load_note(&connection, id, true).is_ok())
    );
    assert_eq!(list_notes(&connection, false, "", None).unwrap().len(), 0);
}

#[test]
fn batch_trash_rolls_back_when_a_later_update_fails() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("one"), "cream", 1, "").unwrap();
    insert_note(&connection, "two", &doc("two"), "sage", 2, "").unwrap();
    connection
        .execute_batch("CREATE TRIGGER reject_second_trash BEFORE UPDATE OF trashed_at ON notes WHEN OLD.id='two' BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END;")
        .unwrap();

    let error = trash_notes_batch(
        &mut connection,
        &["one", "two"],
        &[("one", 0), ("two", 0)],
        10,
    )
    .unwrap_err();

    assert!(error.contains("injected batch failure"));
    assert!(load_note(&connection, "one", false).is_ok());
    assert!(load_note(&connection, "two", false).is_ok());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyNote {
    id: String,
    document: Value,
    plain_text: String,
    title: String,
    preview: String,
    color: String,
    revision: i64,
    updated_at: i64,
}

fn legacy_list(connection: &Connection, query: &str) -> Vec<LegacyNote> {
    let mut statement = connection.prepare("SELECT id, document_json, plain_text, color, revision, updated_at FROM notes WHERE (trashed_at IS NOT NULL)=?1 ORDER BY updated_at DESC").unwrap();
    let needle = query.trim().to_lowercase();
    statement
        .query_map([false], |row| {
            let raw: String = row.get(1)?;
            let document: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            let text: String = row.get(2)?;
            let title = text
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("Untitled note")
                .to_string();
            let preview = text
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("")
                .chars()
                .take(120)
                .collect::<String>();
            Ok(LegacyNote {
                id: row.get(0)?,
                document,
                plain_text: text,
                title,
                preview,
                color: row.get(3)?,
                revision: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .filter(|note| needle.is_empty() || note.plain_text.to_lowercase().contains(&needle))
        .collect()
}

#[test]
#[ignore = "Synthetic benchmark; run explicitly with COZYNOTES_BENCHMARK_OUTPUT"]
fn synthetic_library_benchmark() {
    let mut results = Vec::new();
    for note_bytes in [128, 4096] {
        for count in [100, 1000, 10000] {
            let root = TestRoot::new();
            let mut connection = legacy_database(&root.database());
            let transaction = connection.transaction().unwrap();
            {
                let mut insert = transaction.prepare("INSERT INTO notes (id, document_json, plain_text, color, revision, created_at, updated_at) VALUES (?1,?2,?3,'cream',0,1,?4)").unwrap();
                for index in 0..count {
                    let text = format!(
                        "Note {index}\n{}{}",
                        "ordinary text ".repeat(note_bytes / 14),
                        if index % 10 == 0 { " needle" } else { " other" }
                    );
                    insert
                        .execute(params![
                            format!("note-{index:05}"),
                            doc(&text).to_string(),
                            text,
                            index
                        ])
                        .unwrap();
                }
            }
            transaction.commit().unwrap();
            let mut before = Vec::new();
            for query in ["", "needle"] {
                let mut times = Vec::new();
                let mut payload = 0;
                let mut rows = 0;
                for _ in 0..3 {
                    let start = Instant::now();
                    let notes = legacy_list(&connection, query);
                    rows = notes.len();
                    payload = serde_json::to_vec(&notes).unwrap().len();
                    times.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                before.push(
                    json!({"query":query,"samplesMs":times,"payloadBytes":payload,"rows":rows}),
                );
            }
            drop(connection);
            let connection = open_database(&root.database()).unwrap();
            let mut after = Vec::new();
            for query in ["", "needle"] {
                let mut times = Vec::new();
                let mut payload = 0;
                let mut rows = 0;
                for _ in 0..3 {
                    let start = Instant::now();
                    let notes = list_notes(&connection, false, query, None).unwrap();
                    rows = notes.len();
                    payload = serde_json::to_vec(&notes).unwrap().len();
                    times.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                after.push(
                    json!({"query":query,"samplesMs":times,"payloadBytes":payload,"rows":rows}),
                );
            }
            results.push(json!({"totalNotes":count,"approximateBodyBytes":note_bytes,"before":before,"after":after}));
        }
    }
    let output = json!({"synthetic":true,"buildProfile":if cfg!(debug_assertions) { "debug" } else { "release" },"includes":"SQLite query, Rust mapping and JSON serialization; excludes native IPC, WebView rendering and UI latency","samplesPerQuery":3,"results":results});
    if let Some(path) = std::env::var_os("COZYNOTES_BENCHMARK_OUTPUT") {
        let path = PathBuf::from(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&output).unwrap()).unwrap();
        println!("Benchmark written to {}", path.display());
    } else {
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    }
}
