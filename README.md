# CozyNotes

An offline-first desktop notes app built with Tauri 2, React, TypeScript, and Rust. Write in independent note windows, organize notes in a library, and keep your notes on your device in SQLite. Fonts are bundled locally.

CozyNotes is in early development (0.1.0). Windows has received local validation; macOS and Linux still need native interaction testing. The CI workflow checks the build and automated tests on all three platforms when run on GitHub.

## Features

- A searchable library and independent, frameless note windows.
- Rich text, bullet lists, checklists, and resetting completed checklist items.
- Serialized autosave with revision checks, a 300 ms debounce, a two-second maximum wait during ordinary typing, and save-before-close coordination.
- Unicode-aware, case-insensitive library search with highlighted excerpts and paper-color filters, plus find within a note.
- Six paper colors, note duplication, and Trash with restore and confirmed permanent deletion.
- Local database migrations with safety snapshots of existing libraries.
- Single-instance behavior that brings the existing library into focus.

Images, preferences, a night theme, persistent window geometry, user-facing backup/restore, and exports are not implemented yet. Signed releases and installer distribution are not configured.

## Development setup

Use Node.js **24.15.0 or a newer 24.x release** (the tested version is in `.nvmrc`), npm, and stable Rust with Cargo. Install the native prerequisites for your platform:

- **Windows:** Microsoft C++ Build Tools with the Desktop development with C++ workload, the Windows SDK, and WebView2 Runtime. Use the MSVC Rust toolchain.
- **macOS:** Xcode Command Line Tools.
- **Linux:** WebKitGTK 4.1 and the native build dependencies. On Debian/Ubuntu:

  ```sh
  sudo apt-get update
  sudo apt-get install -y build-essential curl wget file libwebkit2gtk-4.1-dev \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

From the repository root:

```sh
npm ci
npm run tauri dev
```

No API keys, accounts, environment files, or external services are required. `npm run dev` starts the frontend alone; note storage and window commands require the Tauri desktop runtime.

### Network shares on Windows

A local checkout is recommended. For an SMB/UNC checkout, map the repository to a drive and run commands from that drive. Vite can fail to resolve modules through a raw UNC path. Keep Rust output on a local disk to avoid linker errors:

```powershell
$env:CARGO_TARGET_DIR = "$env:TEMP\cozynotes-target"
npm run tauri dev
```

## Build and test

```sh
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Frontend tests cover search, editor actions, and save coordination. Rust tests cover storage, migrations, document validation, and search. Rust commands require the native prerequisites above. These checks do not replace interactive tests of window behavior or installer testing.

An optional synthetic benchmark measures SQLite query, mapping, JSON serialization time, and response bytes for 100, 1,000, and 10,000 notes. It excludes native IPC transport and rendering:

```powershell
$env:COZYNOTES_BENCHMARK_OUTPUT = Join-Path $PWD 'output/everyday-use/backend-benchmark.json'
cargo test --locked --manifest-path src-tauri/Cargo.toml synthetic_library_benchmark -- --ignored --nocapture
```

See the [Everyday Use verification record](docs/everyday-use-verification.md) for the measured results and native test limits.

Build a native executable without generating installers:

```sh
npm run tauri build -- --no-bundle
```

Build platform-specific installers locally:

```sh
npm run tauri build
```

Cargo output goes to `src-tauri/target/`, or to `CARGO_TARGET_DIR` when set. Release executables are under `release/`; installer bundles are under `release/bundle/`. Build output is ignored by Git. Distribute binaries through GitHub Releases rather than adding them to the source tree.

## Using CozyNotes

Move a note using empty space along its top toolbar or footer. Move the library using its heading or branding. Close a note with **More note actions > Close note** or the operating system's close action. Closing a note saves it and keeps it in the library.

While a note has focus, use `Ctrl` on Windows/Linux or `Cmd` on macOS:

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + N | New note |
| Ctrl/Cmd + W | Close note |
| Ctrl/Cmd + F | Find in note |
| Ctrl/Cmd + Shift + F | Open library search |
| Ctrl/Cmd + + / - | Adjust note reading size |
| Ctrl/Cmd + 0 | Reset note reading size |

In the library, `Ctrl/Cmd + F` focuses search. Notes and Trash each remember their own search text and paper-color filter until the library window closes. Choose **All colors** to remove the color filter.

In a note, Find highlights literal, case-insensitive matches across formatting within a text block. Use the arrow controls or `Enter` / `Shift + Enter` to move between matches. `Escape` dismisses Find and returns to the editor selection. Highlights do not change the document or its edit time.

Use **More note actions > Reset completed items** to uncheck completed tasks, including nested tasks. One Undo restores their previous states. The action is disabled when every task is unchecked.

### Local data

The SQLite database lives at `data/cozynotes.sqlite` inside Tauri's per-user app-local-data directory for the application identifier `com.cozynotes.app`. Notes are stored outside the checkout. Existing libraries receive a safety snapshot under the sibling `recovery/` directory before a schema migration.

Migration preserves the original document JSON and edit metadata while backfilling derived search text. An unreadable saved document opens in a read-only recovery view with its available text and a copy action. Opening a note, finding text, or changing a library filter does not create an edit. Failed saves keep the current draft open and offer Retry and Copy draft; editing resumes after a failed close attempt.

For manual desktop testing, debug builds accept `COZYNOTES_TEST_DATA_DIR` pointing to an absolute local directory to isolate test notes. Release builds ignore this variable. Keep databases, logs containing note text, and screenshots containing personal notes out of commits and issue reports.

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | React interface, editor, search, save coordination, and frontend tests |
| `src-tauri/src/` | Rust commands, SQLite storage, document processing, and backend tests |
| `src-tauri/capabilities/` | Tauri window permissions |
| `src-tauri/icons/` | Native application icons |
| `scripts/` | Frontend test runner |
| `licenses/` | Bundled font licenses |
| `.github/` | CI, dependency updates, and contribution templates |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and validation checklist. Use the issue templates for bugs and feature requests.

## License

CozyNotes is licensed under the [MIT License](LICENSE). Bundled fonts and dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
