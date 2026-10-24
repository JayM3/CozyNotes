# Default note settings: implementation and verification

Date: October 24, 2026
Plan: [Default settings for new notes](plans/2026-10-24-default-note-settings.md)

## Delivered behavior

- Settings includes **New note defaults**, between Appearance and App behavior: six paper colors, Source Sans 3/Nunito, 12/14/16/18/20/24 px base text sizes, Classic/Roomy/Large size presets, and custom logical dimensions.
- A scaled sample previews the choices without creating a note. **Save defaults** persists the complete group; **Reset to CozyNotes defaults** changes the draft and still requires Save. Invalid dimensions prevent saving. Failed writes retain the previous effective preferences and preserve the form draft for retry.
- Blank-note creation captures native defaults once and commits note appearance and its initial window arrangement together. Reopening and restoring from Trash use the existing note's metadata. Missing legacy window records retain the factory placement fallback.
- Duplicates use source typography and current expanded dimensions. History restores use recorded typography and the source note's current expanded dimensions, with fresh placement and unfolded state. Copied image ownership and ink document data retain their existing behavior.
- Reading-size buttons and shortcuts remain temporary. Ctrl+0 and reopening use the note's saved base text size. Autosave does not reset an active reading adjustment.
- Border/corner double-click explicitly resets affected dimensions to the current configured default. A shared atomic pair updates after successful settings persistence and is read without application locks or file/database I/O in the Windows callback. Saving defaults alone never resizes a note.
- Note typography applies to content, titles, folded titles, and history previews. The library and application controls retain their own fonts. Font weights 400/500/600/700 and italic styles are bundled for both choices.

## Persistence and compatibility

The settings file advances to version 2 and reads version 1. Missing fields receive factory values. Invalid fields in a supported defaults object fall back individually with a warning while preserving valid defaults and app behavior preferences. Background/desk setting writes preserve note defaults.

SQLite advances from schema 3 to 4, adding `font_family` and `font_size` to notes and history. Existing rows receive Source Sans 3 and 16 px; their paper, documents, edit metadata, history, favorites, Trash status, and placements remain intact. Version-3 schema operations are now guarded so they are not rerun during a version-4 upgrade. The existing verified recovery snapshot and transactional migration remain in use.

The library-only `set_note_defaults` command validates the complete payload and returns canonical defaults only after persistence. Note windows do not gain access to the library's settings commands. Native open failures after a successful creation/copy/restore retain the saved note and report an application error.

## Automated verification

The workspace is on an SMB share. Frontend verification ran against a temporary local copy because the network run stalled. Its dependency lockfile SHA-256 matched the workspace exactly; source files were synchronized before the final checks. Rust build output also stayed on local disk.

| Check | Result |
| --- | --- |
| Full frontend suite (`npm test`) | 20 files, 160 tests passed |
| Focused defaults, Settings, note reading-size, history, and IPC tests | 5 files, 20 tests passed |
| Rust suite (`cargo test --locked --manifest-path src-tauri/Cargo.toml`) | 99 passed, 1 intentionally ignored synthetic benchmark |
| Frontend production build (`npm run build`) | Passed |
| Windows debug application (`npm run tauri build -- --debug --no-bundle`) | Passed |
| Rust formatting and Git whitespace checks | Passed |

New regression coverage verifies settings round trips, invalid-field fallback, failed-write rollback, live reset-cache updates, v3 migration with history/Trash/placements, atomic rollback when placement insertion fails, historical typography, form draft retention, validation, explicit factory reset, and reading-size initialization/reset/reopening/autosave behavior. Existing v1/v2 migration, save coordination, image, ink, and native geometry suites also pass.

Native message tests cover configured border/corner resets, current-cache updates, stationary-edge anchoring, work-area constraints, and simulated 1.0/1.5/2.0 display scales. These are executable native tests, not manual changes to Windows display settings.

The production frontend build retains the existing large-JavaScript-chunk advisory. It does not fail the build.

## Desktop observations and limits

Windows environment: Windows 11 Pro Insider Preview, build 26220.

Used an isolated debug app identity (`com.cozynotes.defaults-test`) and `COZYNOTES_TEST_DATA_DIR` because the installed app was already running in the background. No personal note database was used for verification.

Observed the native Settings page, named swatches, font selection, text-size selection, editable dimensions, matching Roomy preset, focus outlines, and the Sage/Nunito/20 px preview at 400 × 500. The 615 × 500 library view scrolls to the preview and save controls without horizontal overflow.

Live desktop input interrupted the remaining automation. Manual save-and-create, restart/desk restoration, duplication/history restoration, 480 px layout, Night/System themes, and mixed-monitor interaction were **not completed** in this desktop session. Settings persistence, creation/storage semantics, typography, history, and geometry have the automated coverage listed above; that coverage is not a substitute for the uncompleted manual flows.

An ordinary debug executable is provided under the Git-ignored `releases/` directory. It is a development build, not an installer or published release. The temporary test identity was used only for UI verification.

## Scope

Per-note font controls, persistent reading zoom, “Use this note as my defaults,” default title visibility/toolbar height, additional fonts, named user presets, and bulk restyling remain the follow-ups explicitly excluded from the approved initial release.
