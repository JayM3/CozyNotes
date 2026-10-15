# Everyday Use milestone verification

Recorded October 16, 2026 in Asia/Tokyo. Native command logs use October 15 UTC. This record covers the implemented milestone, not every feature planned for the first release.

## Implemented behavior

- Find within a note uses decorations, literal matching, Unicode normalization/full case folding, counts, and wrapping navigation without editing content. Escape returns to the mapped editor selection.
- Library search renders highlighted excerpts as text segments, combines queries with a named paper color, and maintains separate Notes/Trash filters for the current session. Queries debounce by 150 ms and obsolete responses cannot replace current results.
- Reset completed items changes checked tasks, including nested tasks, in one undoable action. Text, marks, nesting, and order remain intact.
- One save coordinator serializes edit generations, debounces by 300 ms, and starts a save within two seconds during continuous ordinary typing. Close waits for composition, stops editing during the final flush, and retains the draft on failure.
- Hydration emits no document update. Unreadable documents open read-only without replacing their stored JSON. Schema version 1 backfills derived summaries and normalized search text transactionally after a verified SQLite safety snapshot.
- List responses omit document JSON and full plain text. Selection changes update formatting controls, and a second launch recreates the library while notes remain open.

## Automated checks

| Check | Result |
| --- | --- |
| Frontend tests | 25 passed: search normalization/ranges, editor Find/reset/history, save generations/debounce/max wait/composition/retry, and latest-request-wins library search/listener cleanup. |
| Rust tests | 12 passed; synthetic benchmark also passed when explicitly invoked. Coverage includes validation, soft breaks, persistence, Unicode excerpts, summary payloads, stale/trashed saves, migration snapshots, rollback, and unsupported schemas. |
| TypeScript and frontend production build | Passed. Vite reports the existing single JavaScript chunk above 500 kB; editor lazy loading remains outside this milestone. |
| Rust checks | `cargo check --locked` and `cargo fmt -- --check` passed. |

## Native Windows checks

The desktop tests used an isolated debug application identifier, a new local synthetic database, the production frontend bundle, and actual Tauri IPC through WebView2. The user's existing application session and live notes were not accessed or changed. Temporary transport delays/failures were injected from the test harness; no test bridge was added to production code.

| Scenario | Observed result |
| --- | --- |
| Legacy database migration | Revision 7 and edit timestamp 2000 survived backfill; hard breaks became newlines in derived text. The pre-migration snapshot retained schema version 0, and both snapshot/live database integrity checks returned `ok`. |
| Library discovery | `STRASSE` highlighted the original `Straße`, text search combined with Sage, and switching Notes/Trash retained independent query/color choices. Summary responses contained no document/plain-text bodies. |
| Opening and Find | Opening the rich-text fixture and finding across bold/plain text preserved revision/edit time. Match navigation wrapped, toolbar state followed caret movement, and Escape restored editor focus. |
| Checklist reset | Two checked tasks, one nested, became unchecked. One Undo restored both and retained editor focus. |
| Keyboard menus | Home/End navigation, Escape dismissal, compact overflow actions, and focus return worked. |
| Delayed save and close | A 700 ms transport delay overlapped newer typing and a synthetic IME composition. Close waited for composition, locked editing for the final flush, and committed the final Japanese text. |
| Failed-save retry | Simulated save failures left the draft open, cancelled close, restored editing, and succeeded through Retry after the failure was removed. |
| Unreadable document | The note opened read-only with its preserved available text. Raw `{unreadable`, revision, and edit timestamp remained unchanged after opening/closing. |
| Desktop lifecycle | Closing the library left the note usable. A second executable launch recreated exactly one library; the note remained open. |
| Shortcuts | Primary+F focused library search or note Find; Primary+Shift+F focused library search from a note. |
| Layout | Embedded final styles passed at 320 x 240 for notes and 480 x 500 for the library. Equivalent 200% layout widths of 160 x 120 and 240 x 250 had no horizontal overflow. Find, menus, search, filters, results, and Trash controls remained reachable by keyboard/scrolling. |
| Runtime errors | No page errors during the completed workflow and final-layout checks. |

Evidence generated locally under `output/everyday-use/` includes `native-verification.log`, `second-launch-verification.log`, `layout-verification.log`, `migration-native-verification.json`, screenshots, and `backend-benchmark.json`. These are local validation artifacts and are ignored by Git. The fixture generator is `scripts/seed-native-test.mjs`; it refuses to replace an existing database and restricts its output to a new test directory beneath the system temporary directory.

Debug builds accept an absolute local `COZYNOTES_TEST_DATA_DIR` for isolation. Release builds compile out this override. Native testing attaches only to a test WebView2 remote-debugging port, never to the live user session.

## Search measurements

The synthetic benchmark compares the former full-document list path with stored search text and summary responses against the same seeded libraries. It measures SQLite query, Rust mapping, and JSON serialization in a debug build, with three samples per query and median times below. These are not native IPC transport, rendering, or end-to-end UI latency measurements.

For approximately 4 KB note bodies and an empty query:

| Notes | Median before / after | Serialized bytes before / after |
| --- | --- | --- |
| 100 | 38.8 / 1.3 ms | 841,971 / 14,861 |
| 1,000 | 439.0 / 24.9 ms | 8,424,651 / 152,561 |
| 10,000 | 4,382.5 / 267.0 ms | 84,296,451 / 1,565,561 |

The selective `needle` query matches 10% of each library. At 10,000 notes, its median changed from 1,334.1 to 305.0 ms and its serialized response changed from 8,431,446 to 289,668 bytes. The raw record also includes approximately 128-byte notes, all sample times, and response sizes at all three library sizes. No general UI speedup or cross-machine performance claim follows from these measurements.

## Remaining verification and scope

Physical IME candidate entry, actual OS/browser zoom controls, assistive-technology testing, forced termination, disk-full conditions, installers/signing, and macOS/Linux native interactions were not exercised in this pass. Composition tests use browser composition events, and zoom checks use equivalent CSS viewport sizes. The database-worker extraction, editor lazy loading, FTS, and virtualization remain outside this milestone.

Images, night theme, persistent window arrangements, user-facing backup/restore, and exports remain unfinished first-release features. Migration safety snapshots are implemented; they are not the planned user-facing backup system. Local history, templates, title-strip folding, and Copy as Markdown remain follow-on ideas.

## Local Windows artifact

The optimized executable was built with `cargo build --release --locked --offline --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml` after the final frontend production build. `TAURI_CONFIG` was unset for this build. Binary checks confirm the normal `com.cozynotes.app` identifier and final embedded stylesheet, with neither the isolated test identifier nor the debug data-directory override string present.

The project-root `CozyNotes.exe` and `CozyNotes-Everyday.exe` are identical, each 7,142,400 bytes. The previous executable was preserved as `output/everyday-use/CozyNotes-before-everyday.exe`; the primary entry point was updated only after the previous application session had exited. The release was not launched against live user notes during verification.

SHA-256 of the new executable:

```text
99fcb9930600e6357e4a42792e5ac8904aa5759c088a5869739fb6f191fc9aad
```
