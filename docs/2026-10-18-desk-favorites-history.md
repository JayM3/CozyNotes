# Desk, favorites, history, and checklist verification

Date: 2026-10-18. Implemented in the working tree for CozyNotes 0.2.0; this record does not indicate a published release.

## Behavior

- **Remember my desk:** enabled by default in Settings. On startup, reopen active notes left open at coordinated app exit, with expanded logical dimensions, supported physical positions, and folded state. Notes closed individually remain closed. Disabling automatic reopening retains placement for manually reopened notes. Native work-area fitting handles disconnected monitors, negative origins, and DPI; Wayland delegates positioning to its compositor.
- **Favorites:** star notes in the library or the note's More menu. Favorites appear before other notes; each group retains edit recency order. Favorites only combines with search and paper color and applies to visible-note selection. Toggling a favorite does not change the edit timestamp/revision or create history.
- **Note history:** More > Note history flushes the current draft before listing up to 100 earlier versions. Preview rich text and images read-only. Restore as new note copies the selected version and its owned images, preserving the current note. History begins with edits saved after this implementation. Permanent deletion removes the note's history.
- **Fold a note:** use the footer arrow or More > Fold note. A 52 logical pixel strip preserves the title, move area, unfold control, and close control. Expanded dimensions are retained. The editor remains mounted, and folding first flushes any draft.
- **Checklist layout:** checkbox and writing share a flex row. Long content wraps within the writing column beside the checkbox.

## Persistence and failure handling

Schema 3 adds `notes.favorite`, `note_history`, and `note_windows`. Existing libraries receive the migration safety snapshot. The schema 2 upgrade preserves note data; reopening an upgraded library does not repeat the migration.

Changed title/body saves archive the previous version in the replacement transaction. Stale or failed saves leave both current content and history unchanged; unchanged saves do not increment revisions. The most recent 100 earlier revisions are retained. Historical references keep image assets available, and restored copies use independent assets. Note deletion cascades history and placement rows.

The open window set is flushed after editor preparation succeeds and before exit is approved. Closing a window individually records it closed. Window resize and move events update runtime placement; focus loss, folding, closing, and coordinated exit persist it. On Windows, resizability is applied before sizing so a reopened folded window remains 52 logical pixels tall.

## Automated verification

- Frontend suite: **110 passing tests across 14 files**, including favorite filtering/selection, failed favorite changes, Remember my desk persistence failure/retry, and history load/preview/restore/error states.
- History suite rerun after the final keyboard focus adjustment: **4 passing tests**. TypeScript checking passes.
- Rust: **39 passing tests**, one intentionally ignored synthetic benchmark. Covers schema upgrades, atomic history, bounded retention, image references, unchanged/stale saves, favorite edit metadata, desk persistence, and monitor fitting.
- `npm run tauri build -- --no-bundle` passed, including the production frontend build and optimized Windows x64 executable, with the temporary exit IPC removed. A local copy is in the ignored `releases/CozyNotes-0.2.0-desk-features-windows-x64.exe`. The existing frontend chunk-size advisory and release-only unused import warning in `assets.rs` remain.
- `cargo fmt -- --check`, `git diff --check`, and JSON parsing of the updated IPC schema pass.

Frontend tests ran in a local temporary mirror because the SMB checkout caused test discovery/watch problems. The mirror used the repository lockfile and current source. Rust output was placed on local disk. No personal library was used.

## Windows runtime verification

Used a debug executable with an isolated test data directory and WebView2 browser automation. Temporary test-only exit IPC was removed after checking coordinated shutdown.

- Reproduced the original checklist issue in the actual Tiptap editor: the checkbox was above its paragraph. Checked the corrected row and a long wrapping checklist item in the native app.
- Changed favorites from the library and note menu and observed cross-window state updates.
- Opened history, previewed old text and an image, and restored a separate note with an independently copied image; the original stayed unchanged.
- Folded, unfolded, moved, resized, exited, and reopened a note. Reopened folded height was 52 logical pixels and expanding retained the saved dimensions.
- Confirmed individually closed notes stayed closed after restart.
- Disabled Remember my desk and confirmed startup opened only the library; restored the preference afterward.
- Inspected the history modal in a 360 by 430 note window and exercised preview scrolling and controls.

Native interaction checks cover Windows only. macOS, Linux, and physical multi-monitor transitions still need platform testing; automated work-area tests cover the disconnected-monitor and negative-origin calculations.
