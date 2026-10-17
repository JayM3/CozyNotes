# Focused architecture review and decision: tray, Settings, selection

October 17, 2026. Baseline 9a4e2b4. Five read-only specialists reviewed architecture, local IPC, storage, refresh costs, and native build/platform behavior.

## System as built

- src/main.tsx -> App.tsx routes note-* labels to NoteWindow; every window uses ThemeProvider.
- Library.tsx owns Notes/Trash routing and filters, calls api.ts invoke commands, and loads lightweight summaries through useLibrarySearch.ts.
- src-tauri/src/main.rs -> lib.rs run() owns app setup, single-instance focus, native windows and commands. Database(Mutex<Connection>) owns the local SQLite connection. storage.rs owns persistence, migrations and document validation.
- Each NoteWindow owns its draft and SaveCoordinator. Its close flow waits for IME, locks editing, flushes, and only then closes (NoteWindow.tsx:115,126).
- save_document uses an immediate transaction and expected revision (storage.rs:209); trash_note directly updates one row in lib.rs:143.
- Theme preference uses localStorage plus Tauri events (theme.tsx:26,87). Native lifecycle cannot read that preference directly.
- All data is local; there is no external service. The capability boundary allows library/note windows and native close/destroy/drag operations.

## Findings and mitigation

1. HIGH: library deletion can race with an open editor's unsaved draft (NoteWindow.tsx:126; storage.rs:226). The requested batch command must prepare every affected editor, keep it locked through the transaction, validate current revisions and cancel on failure. Mitigated in this change.
2. HIGH: repeated single-note trash calls permit partial mutation and repeated refreshes (lib.rs:143; useLibrarySearch.ts:40). Implement one storage transaction and one consolidated event. Mitigated in this change.
3. HIGH: last-window exit and native tray Exit do not have lifecycle coordination (lib.rs:278). Add explicit retained-process policy and safe exit preparation; never use a timeout as permission to quit. Mitigated in this change.
4. MEDIUM: existing custom commands share broad local-window access (lib.rs:54; capabilities/default.json:5). New settings/batch commands are library-only and operation replies derive the editor identity from the invoking native window. Broad changes to existing commands are outside this feature's scope.
5. MEDIUM: every edit can cause multiple full library queries under the same mutex (lib.rs:139; storage.rs:170). New tray refresh uses only ID/title metadata, coalesces requests, and avoids query fan-out per selected note. Existing search pagination/scaling remains outside scope.
6. MEDIUM: Linux tray click events differ and native packaging is not covered by existing CI (.github/workflows/ci.yml:22,46). Keep required actions in the native tray menu; verify Windows locally and state untested platform limits.

Verdict: SOUND WITH RISKS for the requested scope, conditional on the explicit mitigations above. No database schema migration is required.

## ADR: ownership and safe operations

Use the existing Tauri stack and native tray-icon feature. Keep Settings in the existing main-window right pane. Keep theme storage intact and store the background preference natively. Rust coordinates all batch/exit preparation, validates native caller identities, commits storage atomically, and publishes completion. Editors remain the only owners of unsaved text and cannot be destroyed until their flush succeeds. Do not hold database or window-creation mutexes while awaiting editor replies.

The shared payload contract is docs/api/desktop-commands.schema.json. The implementation plan is docs/plans/2026-10-17-tray-settings-selection.md. The user approved the full feature design and implementation on October 17, 2026.
