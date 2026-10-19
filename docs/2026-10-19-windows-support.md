# Windows support scope and verification

Recorded October 19, 2026.

Windows x64 is the current development, testing, and release target. macOS and Linux support, compatibility work, and new release packages are on hold. Their older downloads are historical builds. Future platform support can be reconsidered separately.

## Delivery changes

- CI tests and builds the application on Windows x64.
- Release validation, building, and publishing run on Windows. The release workflow explicitly uses Git Bash so its shell variables, heredocs, and download globs work on Windows runners.
- Tauri's default bundle target is the Windows NSIS installer.
- Releases collect `Cozynote.exe`, the Windows setup executable, the Windows updater executable and its signature, and generate `SHA256SUMS.txt` and `latest.json`.
- The updater manifest advertises only `windows-x86_64`. Package verification requires the complete Windows download set and rejects unexpected artifacts.
- The README, contribution guidance, design scope, and issue/PR templates describe Windows support and validation.

## Local verification

| Check | Result |
| --- | --- |
| Workflow lint | Both workflows passed actionlint 1.7.12. The downloaded tool's SHA-256 matched its published checksum. |
| Release scripts | 17 fixture checks passed against the actual inline workflow scripts and Windows Git Bash commands. |
| Frontend tests | 115 tests passed across 15 files. |
| Rust tests | 82 passed; the synthetic benchmark remained ignored. |
| Rust formatting | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` passed. |
| TypeScript and production frontend build | Passed through Tauri's normal `beforeBuildCommand`. |
| Windows executable and NSIS packaging | Native debug executable and `CozyNotes_0.2.3_x64-setup.exe` built successfully. |
| Patch whitespace | `git diff --check` passed. |

The release fixtures covered matching and mismatched manifest versions, wrong tag refs, missing release notes, installer/updater/signature collection, the standalone copy command, checksum contents, Windows-only updater metadata, and rejection of missing, ambiguous, empty, or unexpected artifacts.

The network-checkout frontend test run was stopped after slow discovery. Tests then ran from a temporary local copy installed with `npm ci`; all 41 tracked frontend source files, package manifests, TypeScript configurations, Vite configuration, and the test runner were verified against the checkout before the successful run.

The installer check used a temporary `bundle.createUpdaterArtifacts: false` override for debug packaging. Fixture signatures exercised metadata and file handling. GitHub-hosted execution, real release signing, updater installation, and fresh-install interaction were not exercised in this local pass.
