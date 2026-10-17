# CozyNotes: tray access, Settings, and bulk selection

Date: October 17, 2026
Status: Approved by the user on October 17, 2026.

## Requested result

CozyNotes remains reachable while its windows are closed, provides a dedicated Settings page in the main window, and lets users select note rows to delete several notes together.

The user confirmed that the background icon and right-click menu belong in the system tray beside the Windows clock.

## User-facing design

### System tray and background operation

- Create a CozyNotes tray icon when the application starts, using its existing native icon.
- Right-click opens a native menu with these entries, in this order:
  - Notes: a submenu listing active notes, most recently edited first. Choosing a title opens or focuses that note's existing window. An empty library displays a disabled No notes yet entry.
  - Show main menu: opens or focuses the main window on its Notes page.
  - Exit CozyNotes: saves open drafts, then closes all windows and terminates the process.
- Trashed notes are excluded from the Notes submenu. Titles and membership update after edits, creation, trashing, restoration, and permanent deletion.
- Run in background is enabled by default. Closing the main window hides it and keeps the tray available. Closing the last note window also leaves the application running.
- Closing a floating note retains its existing save-before-close behavior.
- Turning Run in background off restores normal window closing: the app exits after its last window has safely closed. The tray stays available while the app is running.
- Explicit Exit CozyNotes always exits, regardless of the background preference, once every open draft has saved successfully.
- A failed save or unresponsive editor cancels exit and keeps the draft available with a visible error. The application must not force an exit after a timeout.
- If tray creation fails, background hiding is disabled for that run so the user can still reach and close the app.

### Settings in the main window

- Replace the Appearance chooser at the bottom of the left rail with a Settings navigation button and gear icon.
- Selecting Settings replaces the right content pane with a page headed Settings. The main window's left rail stays visible.
- Appearance contains the existing Warm, Night, and System choices. The choice still applies immediately across open windows and is remembered between launches.
- App behavior contains a Run in background switch, explained as Keep CozyNotes in the system tray when all windows are closed. This preference is remembered between launches.
- Notes and Trash navigation return to their respective lists. Each list's search and paper-color filters are retained.
- Preserve the current visual language, semantic colors, responsive rail, frameless dragging, and visible keyboard focus.

### Select notes and delete in a batch

- Replace each decorative circle at the right of a note row with a real checkbox in the same position. Keep the paper color visible and display a checkmark when selected.
- Checkbox activation selects or deselects the note without opening it. Keyboard Tab and Space work, and the accessible label identifies the note.
- While any notes are selected, show a compact action bar with the selected count, Select all, Clear selection, and the relevant delete action.
- Select all selects only notes in the current search and paper-color results. The control reflects partial selection.
- Changing page, search text, or paper-color filter clears selection. Refreshes remove selections for notes that no longer appear.
- In Notes, Move to Trash moves the selected notes together. They remain recoverable through Trash.
- In Trash, Delete selected asks for confirmation with the number of notes, then permanently deletes only the selected trashed notes. Existing single-note actions and Empty Trash continue to work.
- Disable conflicting actions while a batch operation is pending. On failure, preserve selection and display an actionable error.
- Before moving an open note to Trash, flush its draft safely. If any selected editor cannot save, leave all selected notes in place and preserve all drafts.
- After successful soft deletion, close the affected floating note windows and refresh the list and tray menu.

## Approaches considered

1. Recommended: native Tauri tray/menu, the existing main-window right pane for Settings, and one Rust batch operation with coordinated editor saves. This fits the current stack, avoids another settings window, and gives the batch a single commit boundary.
2. A custom webview popup for tray navigation would allow richer previews but adds another window, focus management, and more platform-specific interaction than the requested menu needs.
3. Calling the existing single-note trash command repeatedly is a smaller patch but can leave a partially deleted selection and does not coordinate unsaved drafts in other note windows.

## Architecture and contracts to implement after approval

- Keep SQLite ownership in Rust. Put batch storage operations alongside the existing storage functions; use a transaction and parameterized queries with validated, deduplicated explicit note IDs.
- Treat Notes and Trash as data views; keep Settings as a main-window page so it cannot accidentally query or mutate Trash.
- Keep the appearance preference's existing storage key and cross-window synchronization. Store the native background preference in a small versioned application settings file, with an enabled default and reported persistence failures. No SQLite schema change is required.
- Add a shared native operation coordinator for exit and batch trash. It selects affected editor windows, sends a request identified by an operation ID, waits for each window to finish composition and flush autosave, and commits only after all editors report success.
- Editors stay locked between successful preparation and the native commit decision, preventing new edits from racing with deletion or exit. On cancellation or failure, release all prepared editors for continued editing.
- Do not hold the database or window-coordinator mutex while awaiting frontend replies or creating windows. Keep WebView2 window creation on the existing asynchronous path.
- Ignore stale replies and derive each reply's window identity from the invoking native window. Serialize conflicting batch and exit operations.
- Refresh tray entries using lightweight note metadata and coalesce repeated refresh requests. Errors remain visible through the main window or affected editor.
- Write concrete IPC payloads and error behavior before implementing the new commands.

## Acceptance checks after implementation

1. Launch the Windows app and find its icon in the system tray. Inspect the three requested menu entries.
2. Create and rename notes, then open each through the Notes submenu without creating duplicate note windows.
3. Close the main window and all note windows with background enabled, then reopen the main window from the tray.
4. Disable background operation, restart, and confirm the saved choice and normal final-window exit behavior.
5. Choose each appearance option from Settings and confirm open note windows update and the preference survives restart.
6. Select one note, several notes, all visible search results, and clear the selection using both pointer and keyboard.
7. Move a selected batch to Trash and verify that unselected and filtered-out notes remain active.
8. Edit a selected open note immediately before batch trash. Restore it and verify the latest text was saved.
9. Simulate a save failure during bulk trash and during Exit CozyNotes. Confirm no batch is committed and all drafts remain available.
10. Confirm permanent bulk deletion in Trash reports the correct count and leaves unselected notes intact.
11. Check the 480px minimum window width, Warm/Night appearances, focus visibility, and screen-reader control names.
12. Run relevant frontend, Rust, formatting, production frontend build, and debug native build checks. Record native platform limits.

## Design review

The design has no undecided behaviors or placeholders. The user approved the tray location and then explicitly approved the complete design for implementation. The next step after approval is A Team's writing-plans workflow, followed by implementation in the isolated feature worktree.

