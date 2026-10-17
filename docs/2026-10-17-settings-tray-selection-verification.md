# Tray, Settings, and selection verification

Date: October 17, 2026.

Scope: the approved design in `specs/2026-10-17-settings-tray-selection-design.md` and local desktop contract in `api/desktop-commands.schema.json`.

## Isolation

Development uses branch `feat/settings-tray-selection` in `../worktrees/settings-tray-selection`, starting from `9a4e2b4`. The existing installed/running CozyNotes executable and the user's note data are not used for native verification. Windows checks use a separate application identifier and synthetic notes beneath the system temporary directory.

## Baseline

Before implementation, the frontend production build succeeded, the frontend suite passed 62 tests in 6 files, and Rust passed 12 tests with one pre-existing ignored synthetic search benchmark. Frontend JSDOM startup over the network drive was slow; a local verification mirror uses the same lockfile and source without modifying the project's test runner.

## Final verification

The final frontend source was copied to the local verification mirror. The source matches the worktree; generated Vitest cache files are excluded from source comparison.

| Command | Result |
| --- | --- |
| `npm test` | 90 tests passed in 11 files; 16.95 seconds |
| `npm run build` | TypeScript and Vite production build passed |
| `npm test -- editorOperation.test.ts` | 12 preparation/cancellation/recovery tests passed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed |
| `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` | 26 passed; one pre-existing ignored synthetic benchmark |
| `cargo build --locked --offline --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml` | Separate-identity Windows debug build passed |
| `cargo build --release --locked --offline --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml` | Final normal Windows release build passed; 2 minutes 9 seconds |

The production build retains the existing warning about a JavaScript chunk above 500 kB. No bundle-size optimization is part of this feature.

The final production bundle was built directly from the feature worktree. The frontend test mirror uses identical source; generated Vitest cache files are excluded from comparison. The final JavaScript entry is `index-DNwX4JAL.js`.

## Windows runtime observations

The isolated application used identifier `com.cozynotes.traycheck01a1495d` and synthetic data in a dedicated temporary directory. WebView2/CDP checks attached only to that instance.

- Settings opened in the right pane; Warm/Night/System appearance and background preferences persisted across reload/restart. Native settings reported the tray was available.
- With Run in background enabled, closing the library kept the process alive. A second launch reopened the library through the single-instance handler.
- With Run in background disabled, closing the final window exited the process. This also cleanly stopped the isolated application after verification.
- Bulk trash prepared an open editor, saved text entered immediately before the action, closed the editor after commit, and displayed the latest text in Trash. Restore retained that text.
- Permanent deletion displayed the selected count, initially focused Cancel, and removed the confirmed synthetic Trash selection.
- Search-filtered Select all selected only the visible result. Space toggled its focused row checkbox.
- A temporary SQLite trigger rejected document saves for one synthetic note. Bulk trash returned `An editor failed to save`; the stored row stayed active and unchanged, and the unsaved draft stayed open and editable. After removing the trigger, Retry persisted the draft, and its window closed normally.

## Independent reviews

Native spec review, frontend spec review, and editor spec review passed. Frontend quality review passed after adding a recoverable finish-status check: Retry checks whether cancellation completed before flushing, and cannot unlock an active or committed operation. Its two new regression cases were observed failing before the fix and passing afterward.

Security/database review and the follow-up library-only error-queue command review passed. Frontend and native quality re-reviews passed after adding safe Close and later-exit preparation for a saved editor whose native window survived committed trash. A retained native error queue prevents startup listener timing from hiding tray errors. Regression cases for queue retention, startup error display, and retired-editor exit preparation were observed failing before implementation and passing afterward. No actionable review blockers remain.

## Verification limits

The Windows desktop helper could not reliably capture the selected application and did not expose the notification area as a targetable window. Physical tray menu interaction, including the explicit Exit CozyNotes command, was therefore not exercised. Native tray creation was confirmed by the application, while coordinator tests cover failed acknowledgments and timeouts. The runtime failed-save test exercised the shared preparation path through bulk trash. The final error-queue and surviving-window recovery changes were verified by regression tests and source review; the native window-destruction failure was not injected. macOS, Linux, installers, and coverage percentages were not checked in this Windows session.

## Deliverable

The Windows x64 executable is saved as `CozyNotes/releases/CozyNotes-Settings-Tray.exe` in the original repository, using a distinct filename. It is 9,484,800 bytes.

SHA-256: `b1ea6671738af8e5c70f84fcc41dcbfb9f77a50438bfef9afc0d71a470efc4ac`.

The binary contains the normal `com.cozynotes.app` identifier and CozyNotes 0.1.0 product metadata. It contains neither the separate test identifier/product name nor the debug-only `COZYNOTES_TEST_DATA_DIR` override. The packaged release was not launched against the user's note library.

No task-generated raw error logs or dumps remain in the feature workspace. Automatic command approval rejected cleanup of temporary browser snapshots; those evidence files remain in the isolated verification directory under the system temporary folder.
