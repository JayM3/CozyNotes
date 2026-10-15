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

fn legacy_database(path: &Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE notes (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, plain_text TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'cream', revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER);").unwrap();
    connection
}

fn legacy_insert(connection: &Connection, id: &str, raw: &str, text: &str) {
    connection.execute("INSERT INTO notes (id, document_json, plain_text, color, revision, created_at, updated_at) VALUES (?1,?2,?3,'sage',7,11,22)", params![id, raw, text]).unwrap();
}

#[test]
fn persistence_and_stale_revisions_are_atomic() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    let note = insert_note(&connection, "one", &doc("before"), "cream", 10).unwrap();
    assert_eq!(note.revision, 0);
    let saved = save_document(&mut connection, "one", 0, &doc("after"), 20).unwrap();
    assert_eq!((saved.revision, saved.updated_at), (1, 20));
    assert!(
        save_document(&mut connection, "one", 0, &doc("stale"), 30)
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
            save_document(&mut connection, id, 7, &doc("replacement"), 100)
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
    insert_note(&connection, "rich", &document, "mist", 1).unwrap();
    assert_eq!(
        load_note(&connection, "rich", false).unwrap().document,
        Some(document)
    );
}

#[test]
fn invalid_saves_never_modify_existing_rows() {
    let root = TestRoot::new();
    let mut connection = open_database(&root.database()).unwrap();
    insert_note(&connection, "one", &doc("original"), "cream", 5).unwrap();
    for invalid in [
        json!({"type":"doc","content":[]}),
        json!({"type":"doc","content":[{"type":"text","text":"wrong parent"}]}),
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"bad mark","marks":[{"type":"future"}]}]}]}),
        json!({"type":"doc","content":[{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":"true"},"content":[{"type":"paragraph"}]}]}]}),
        json!({"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"marked code","marks":[{"type":"bold"}]}]}]}),
    ] {
        assert!(save_document(&mut connection, "one", 0, &invalid, 100).is_err());
        let original = load_note(&connection, "one", false).unwrap();
        assert_eq!((original.revision, original.updated_at), (0, 5));
        assert_eq!(original.document, Some(doc("original")));
    }
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
    insert_note(&connection, "unicode", &doc(&text), "sage", 1).unwrap();
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
    insert_note(&connection, "one", &doc("original"), "cream", 1).unwrap();
    connection
        .execute("UPDATE notes SET trashed_at=5 WHERE id='one'", [])
        .unwrap();
    assert!(save_document(&mut connection, "one", 0, &doc("replacement"), 10).is_err());
    assert_eq!(
        load_note(&connection, "one", true).unwrap().document,
        Some(doc("original"))
    );
    assert!(load_note(&connection, "one", false).is_err());
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
