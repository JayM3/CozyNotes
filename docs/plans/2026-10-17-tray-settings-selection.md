# Implementation plan: tray, Settings, and note selection

Date: October 17, 2026
Authorization: the user explicitly approved the complete design and implementation in this chat.
Spec: docs/specs/2026-10-17-settings-tray-selection-design.md
Contract: docs/api/desktop-commands.schema.json (review required before code).
Worktree: ../worktrees/settings-tray-selection, branch feat/settings-tray-selection, baseline 9a4e2b4.

## Requirements

Implement the approved native tray menu, remembered background operation, right-pane Settings with existing Appearance choices, and note-row selection with atomic soft/permanent bulk deletion. Preserve draft saving and keyboard access.

## Phase 1: establish contracts and baseline

1. docs/api/desktop-commands.schema.json: review payloads, native caller identity, cancellation and atomic mutation semantics before implementing commands. Why: both UI and Rust must share one contract. Dependency: approved spec. Risk: medium.
2. docs/architecture/2026-10-17-tray-settings-selection.md: capture the focused architecture review and ADR. Why: record the draft-loss and retained-window risks with mitigations. Dependency: read-only specialist reviews. Risk: low.
3. Existing project scripts: install locked dependencies in the feature worktree; run baseline frontend tests/build and Rust tests with local CARGO_TARGET_DIR. Why: distinguish pre-existing failures. Dependency: isolated checkout. Risk: low.

## Phase 2: native desktop behavior

Each numbered item is split into small changes within its named file; write a meaningful failing regression test before the corresponding behavior.

4. src-tauri/src/storage.rs and storage_tests.rs: add explicit-ID selection validation, all-or-nothing batch trash with current revision checks, and batch purge restricted to Trash. Why: avoid partial batches and lost/stale saves. Dependency: contract review and baseline. Risk: high.
5. src-tauri/src/settings.rs: add versioned native background preference persistence, default on, warning/fallback on read failure, and retain old state on failed writes. Why: native closing behavior needs a durable source of truth. Dependency: contract. Risk: medium.
6. src-tauri/src/operations.rs: track one correlated pending operation, expected editor identities, acknowledgments, and cancellation. Why: share safe preparation for trash and exit. Dependency: contract. Risk: high.
7. src-tauri/src/desktop.rs: implement native tray creation/menu refresh, safe show/focus, close/background handling, and explicit safe exit. Why: keep the application reachable when windows close. Dependency: steps 5 and 6. Risk: high.
8. src-tauri/src/lib.rs: register narrow commands, connect native lifecycle and lightweight tray refresh to existing mutations, keep locks out of async waits, prevent conflicting opens/mutations during preparation. Why: integrate the requested behavior with current window/data ownership. Dependency: steps 4-7. Risk: high.
9. src-tauri/Cargo.toml and Cargo.lock: enable Tauri tray-icon and only required async features. Why: use existing native Tauri support. Dependency: contract. Risk: low.

## Phase 3: main-window interface and editor preparation

10. src/api.ts: add typed settings/batch commands matching the reviewed contract. Why: keep UI invocation payloads explicit. Dependency: contract. Risk: low.
11. src/Settings.tsx: display Appearance and native Run in background with loading/error handling. Why: move settings to a dedicated page. Dependency: step 10. Risk: low.
12. src/Library.tsx: add Settings navigation/right-pane routing; retain Notes/Trash filters and handle tray Show main menu events. Why: meet requested main-window navigation. Dependency: step 11. Risk: medium.
13. src/Library.tsx: replace decorative dots with accessible checkboxes, visible-result Select all, selected count/Clear, correct batch actions and permanent-delete confirmation; discard stale selections. Why: make the marked control support bulk deletion. Dependency: step 10. Risk: medium.
14. src/styles.css: style Settings, selection and switches using current tokens; handle 480px width, forced colors and keyboard focus. Why: preserve current appearance and usable targets. Dependency: steps 11-13. Risk: low.
15. src/useLibrarySearch.ts: refresh once on the consolidated batch event. Why: avoid per-note event storms. Dependency: contract. Risk: low.
16. src/editorOperation.ts and tests: implement cancellable native preparation with operation validation, editor locking, flush, acknowledgment, and release on failure/timeout cancellation. Why: prevent edits racing with native commit. Dependency: contract. Risk: high.
17. src/NoteWindow.tsx: install prepare/finish listeners before enabling editing; integrate with existing savedAction/IME/close guard and block local actions during preparation. Why: retain existing draft safety. Dependency: step 16. Risk: high.

## Phase 4: integration, review and delivery

18. Frontend component and Rust integration tests: cover filtering/selection, Settings errors, atomic batch rollback, settings persistence, operation acknowledgment/cancellation and IME/save races. Dependency: corresponding implementation. Risk: medium.
19. Entire change: spec review first, then code-quality/Rust/security review; resolve actionable findings. Dependency: all implementation. Risk: medium.
20. README.md, design.md, docs: document tray access, Settings location and bulk deletion; record fresh test/build/native observations. Dependency: working flows. Risk: low.
21. Build and exercise the Windows app with isolated test data, including tray menu and safe exit; create a runnable executable under releases. Run relevant tests, formatting and frontend/native builds after final changes; remove only this task's diagnostic debris. Dependency: reviews. Risk: medium.

## Parallel ownership

Native implementer owns src-tauri/** only. Interface implementer owns src/Library.tsx, src/Settings.tsx, src/api.ts, src/styles.css, src/useLibrarySearch.ts and their new UI tests only. Parent owns editorOperation.ts/tests, NoteWindow.tsx, documentation and integration. All edits use the isolated feature worktree with disjoint write sets. Reviews inspect the combined diff after integration.

## Success criteria

- All three requested user flows work in the Windows build.
- Draft save failure or a missing acknowledgment cancels exit and bulk trash without partial data changes.
- Settings and theme persist; selections cannot affect hidden filter results.
- Relevant frontend/Rust tests, formatting and builds pass; native verification limits are recorded accurately.
