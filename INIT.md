# INIT.md — CozyNotes

## What I understood

CozyNotes is an existing local desktop notes application built with Tauri 2, Rust, React and TypeScript. The current task adds native tray access and background operation, a dedicated Settings pane, and bulk note selection/deletion. The user approved the complete design and implementation on October 17, 2026.

## Project overview

- Status: active development, version 0.1.0.
- Platforms: Windows, macOS and Linux desktop. This task has a Windows execution environment.
- Storage: per-user local SQLite. Notes and fonts work offline; no external service or account is involved.
- Build: npm/Vite/TypeScript frontend; Cargo/Tauri native application.
- Active AI environment: Codex desktop with the A Team skills.

## Rules for this task

- Work in the isolated feature worktree on feat/settings-tray-selection.
- Preserve existing note documents and draft-saving guarantees.
- Follow the approved design in docs/specs/2026-10-17-settings-tray-selection-design.md and the reviewed local IPC contract in docs/api/desktop-commands.schema.json.
- Make bulk storage mutations atomic. Save open drafts before batch trash or explicit exit; cancel on failure or timeout.
- Use separate native test data and app identity when the user's existing copy is running.
- Keep personal notes, generated binaries, diagnostic output and local databases out of commits.
- No production schema migration is part of this feature.

## Team and plan

The scoped responsibilities are recorded in .agent-sync/TEAM.md. The implementation plan and focused architecture decision are under docs/plans and docs/architecture.
