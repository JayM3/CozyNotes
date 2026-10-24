# Plan: default settings for new notes

Date: October 24, 2026
Status: Approved and implemented on October 24, 2026. See ../2026-10-24-default-note-settings.md for verification and limitations.

## Recommended behavior

Add **New note defaults** to Settings, between Appearance and App behavior. The description should say: “Choose how new notes start. Existing notes keep their appearance.”

Defaults are copied into a note when it is created. Reopening an existing note uses that note's saved appearance and window arrangement. Changing defaults must not restyle, resize, or rewrite existing notes, including notes in Trash or notes that have never been opened.

### Initial controls

| Setting | Proposed control | Factory value |
| --- | --- | --- |
| Paper color | Named, keyboard-accessible swatches using the existing six colors | Cream |
| Note font | Select with Source Sans 3 and Nunito, the two font families already in the project | Source Sans 3 |
| Text size | Select: 12, 14, 16, 18, 20, 24 px | 16 px |
| Note size | Presets plus custom width and height in logical pixels | 305 × 385 |

Proposed size presets: Classic (305 × 385), Roomy (400 × 500), and Large (520 × 640). Custom sizes should initially accept whole-number widths of 305–1600 and heights of 240–1600. These upper bounds are a product proposal; the lower bounds match the current native window minimums. Fit actual windows to the available monitor work area without changing the user's global preference.

Include a small preview with a title, paragraph, and checklist. Reuse note paper tokens and typography rules. Show the selected dimensions explicitly; a scaled preview must not imply that it is actual size. The preview uses sample content and does not create or save a real note.

Use **Save defaults** for the complete group, with inline validation, saving/saved feedback, and a retryable error. **Reset to CozyNotes defaults** fills the draft with factory values; the user still presses Save defaults. App behavior switches retain their existing immediate-save behavior. Preserve an unsaved defaults draft if an unrelated switch returns updated app settings.

### Scope and precedence

| Action | Appearance and size behavior |
| --- | --- |
| Create from the library, empty state, note toolbar, or Ctrl+N | Capture one current defaults snapshot in Rust; save appearance and initial expanded window size with the new note |
| Reopen a note or restore the desk | Use the note's stored appearance and last saved window arrangement |
| Restore from Trash | Preserve that note's existing appearance and arrangement |
| Duplicate | Copy the source note's paper, font, base text size, and current expanded dimensions; use a fresh placement and start unfolded |
| Restore a history version as a new note | Use the version's recorded paper/font/base text size; use the source note's current expanded dimensions because window arrangements are not versioned |
| Change global defaults | Affect subsequent blank notes; leave existing notes and content history untouched |

For copies/restores whose source has no saved placement, use the existing factory placement fallback. Keep existing behavior for assets, fresh IDs, favorites, and transient pin state.

Treat the selected text size as the note's saved **base reading size**. Keep the existing footer buttons and Ctrl+plus/minus as temporary reading adjustments in this first release. Ctrl+0 resets to that note's saved base size, and reopening starts at that base size. This avoids silently expanding a defaults feature into a change to reading-zoom persistence. The Settings help text should make the temporary adjustment behavior clear.

For the native border-double-click gesture, reset the requested dimension to the **current configured default size**. This is an explicit user action, so it can resize an existing note. Preserve opposite-edge anchoring, frame offsets, monitor fitting, and folded-note protection. Saving new defaults alone never resizes a window.

## What the current code provides

- `src/Settings.tsx` already hosts Appearance, native app preferences, update checks, and loading/save errors.
- `src-tauri/src/settings.rs` owns a versioned native settings file and only changes effective preferences after persistence succeeds. Its current file version is 1.
- `src-tauri/src/lib.rs::create_note` is the common creation entry point and currently inserts Cream explicitly. The library and note shortcuts already call it through `notesApi.create()`.
- `src-tauri/src/storage.rs` stores paper color with each note. Schema version 3 also has `note_windows` and `note_history` tables.
- `src-tauri/src/desk.rs` remembers expanded dimensions and fits windows to monitor work areas. Its default is 305 × 385; minimums are 305 × 240.
- `src/NoteWindow.tsx` initializes reading size to 16 in component state; Ctrl+0 also uses 16. Font family is inherited from the application body token.
- `src/App.tsx` imports Source Sans 3 and Nunito. Nunito currently loads only 600/700, so a note font option needs the appropriate body weights and italic styles.
- `src/NoteHistory.tsx` and its CSS currently render previews at a fixed 16 px.
- `src-tauri/src/snapping/windows.rs::reset_size` currently resets dimensions using factory constants.

The central creation command is the right integration point: note windows do not need to fetch or maintain a live copy of global defaults.

## Data and command design

Introduce a small native `NoteDefaults` value with matching TypeScript types:

```ts
type NoteDefaults = {
  color: PaperColor;
  fontFamily: "source-sans-3" | "nunito";
  fontSize: 12 | 14 | 16 | 18 | 20 | 24;
  width: number;
  height: number;
};
```

Use stable font identifiers mapped to known CSS font stacks. Validate colors, fonts, supported text sizes, and bounded integer dimensions in Rust as well as in the UI. A focused `src-tauri/src/note_defaults.rs` can own the values and validation without mixing them into document parsing or native startup behavior. A small frontend catalog can supply labels and CSS mappings.

Extend `AppSettings`/`SettingsResponse` with `noteDefaults`. Add a library-only `set_note_defaults({ defaults })` command that validates and saves the complete group, returning the canonical saved `NoteDefaults`. Returning the focused value also avoids coupling this save's success response to an unrelated startup-registration query. Existing settings setters must preserve note defaults when rewriting the settings file.

Persist the new settings format as version 2, with explicit reading of version 1. Missing fields receive factory values. For a parseable supported file, invalid default fields should fall back with a warning while preserving valid existing app preferences. Failed writes leave all previous effective defaults active. Retain the existing unsupported/corrupt-file warning behavior. Do not claim compatibility with older executables reading the new format.

Add `font_family` and `font_size` to `notes` and `note_history`; expose them in `Note` and `HistoryVersion`. Keep color in its existing column and dimensions in `note_windows`. Typography belongs to note metadata, so it does not require adding font marks to Tiptap document JSON or rewriting paragraphs. Library summaries can keep their existing application typography and need no new fields.

Snapshot settings once at blank-note creation, release the settings lock, and insert the note plus initial `note_windows` row in one database transaction. Only publish creation/open the window after commit. Reading defaults later in `desk::load()` would incorrectly change older notes that lack window records, so preserve its factory fallback for existing notes.

Creation, duplication, and history restoration should pass explicit appearance and placement values to shared storage helpers. Avoid a generic insert helper that silently consults current global defaults; copies and history restores have different sources of appearance.

No broad settings event or new note-window access to the library-only `get_settings` command is needed. Native size-reset handling does need access to the saved default dimensions: provide cached values that update for existing windows only after a successful settings save, without settings-file/database I/O or blocking application locks inside the Windows callback.

## Implementation sequence

1. **Define the contract and settings model.** Update `docs/api/desktop-commands.schema.json`, Rust settings/defaults types, and `src/api.ts`. Specify validation, factory values, caller identity, and failure behavior. Add persistence and legacy-settings coverage.

2. **Add schema version 4 safely.** Update `src-tauri/src/storage.rs`, history reads/writes, and tests. Backfill existing notes and history with Source Sans 3 and 16 px, regardless of the user's configured defaults. Preserve paper, text, assets, revisions, timestamps, favorites, Trash, and window records. The current version-3 migration block is unconditional inside `migrate`; guard it with `version < 3` before introducing version 4, or an existing v3 database would attempt to recreate existing columns/tables. Retain the verified pre-migration snapshot and transaction.

3. **Wire native creation and placement.** Update `create_note`, duplicate, and history restore in `src-tauri/src/lib.rs`. Commit appearance and initial dimensions together. Reuse `desk.rs` for later fitting and remembered placement. Preserve a successfully saved note if opening its window fails and report the opening failure clearly.

4. **Render saved typography.** Update `NoteWindow.tsx`, history previews, font imports, and `styles.css`. Apply the selected font to note content, title/highlight layers, and folded title; retain application fonts for controls, dialogs, and library rows. Initialize temporary reading size from the saved base size and reset to that value. Ensure autosave responses do not reset an active temporary reading adjustment. Preview historical typography from each version, including the fixed legacy fallback.

5. **Build New note defaults.** Add a focused component under `Settings.tsx` for the form and preview. Use existing theme/paper tokens and focus styles, labels for every field, named swatches, keyboard access, and an announced save result. Ensure the layout works at the library's 480 px minimum width. Reuse one shared settings load/error state so the new section is not dependent on rendering App behavior.

6. **Connect native size reset.** Update `snapping/windows.rs` and the narrow attachment/cache plumbing. Resolve current configured reset dimensions while retaining the current frame/anchor calculations. Test newly opened and already-open windows after a defaults change.

7. **Verify and document.** Update `README.md` and `design.md` with new-note scope, text-size adjustment/reset behavior, and border reset semantics. Record automated checks and isolated Windows observations before treating the feature as complete.

## Acceptance checks

- Save Sage, Nunito, 20 px, and 400 × 500; every blank-note creation entry point uses all four choices, including after an app restart.
- Change defaults again; existing open/closed/trashed notes keep their own saved appearance. A pre-existing note without a `note_windows` row still uses the legacy placement fallback.
- Reopen a note after resize and desk restoration; remembered geometry wins over defaults. A monitor with less room constrains the actual window without changing global defaults.
- Ctrl+plus/minus adjusts reading size temporarily; Ctrl+0 returns to the note's base; reopening restores that base. Saving content does not unexpectedly reset the temporary adjustment.
- Duplicate and history restore preserve the defined source appearance, expanded dimensions, document, and independent assets. Old history previews retain the legacy font/size.
- Migrate fresh databases and representative v1/v2/v3 databases, including existing history and window records. Verify documents and metadata survive and reopening does not rerun the migration.
- Reject invalid IPC values, preserve app behavior preferences, retain the defaults draft after a failed save, and keep the previous effective defaults after a persistence failure.
- A failed creation transaction leaves neither a partial note nor an orphan placement. A failed native open leaves the committed note recoverable in the library.
- Verify border and corner reset at 100%, 150%, and 200% display scaling, after changing defaults while notes are open; verify opposite-edge anchoring, monitor boundaries, and folded-note behavior.
- Check fonts, title search highlights, history, and previews in Warm/Night/System themes, plus long text, lists, images, and ink. Typography changes must preserve ink stroke data and its existing paper-coordinate behavior.

Use the existing frontend tests/build, Rust tests/formatting, and debug native build. Run desktop checks with `COZYNOTES_TEST_DATA_DIR`; no personal library data is needed. Add behavior tests around settings persistence, migration, transactional creation, and typography/shortcut initialization rather than tests that only mirror component markup.

## Follow-ups, outside the initial release

- Per-note font controls and deliberately persistent reading-size overrides.
- “Use this note as my defaults,” including its current expanded size.
- Default title visibility and toolbar height, once their persistence semantics are defined.
- Additional bundled serif/monospace fonts and named style presets.
- An explicit apply-to-selected-notes flow, if requested later. Bulk restyling should be a separate action with clear scope rather than a side effect of changing defaults.
