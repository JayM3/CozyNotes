# A Team — CozyNotes feature scope

Date: October 17, 2026

| Role | Responsibility |
| --- | --- |
| Coordinator | Approved design/contract/plan, editor preparation, integration, documentation, final verification and delivery |
| Architect/planner | Read-only architecture decision and pre-implementation contract review |
| Native implementer | Rust storage batch operations, settings persistence, tray menu and lifecycle coordination; src-tauri only |
| Interface implementer | Library navigation, Settings, accessible selection, typed invoke helpers and their tests |
| Debugger | Investigate the existing full frontend test runner stall and repair only a proven cause |
| Spec reviewer | Verify implementation matches the approved behavior and IPC contract |
| Code/Rust reviewer | Review the complete code change after spec compliance, including concurrency and lifecycle handling |
| Security reviewer | Review new IPC caller identity, correlated acknowledgments and atomic mutation boundaries |

Architecture, storage, performance, infrastructure and security specialists reviewed the baseline. Their concrete findings and accepted scope boundaries are recorded in docs/architecture/2026-10-17-tray-settings-selection.md. Domains unrelated to this local desktop feature are not active.

Independent implementation slices use disjoint file ownership in the shared feature worktree. Reviews are read-only. Native Windows checks use synthetic notes in a separate test directory.
