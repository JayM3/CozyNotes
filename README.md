<p align="center">
  <img src="src/assets/cozynotes-logo.png" alt="CozyNotes — a little cat with a notebook" width="320" />
</p>

<h1 align="center">CozyNotes</h1>

<p align="center">
  <strong>A little home for your notes.</strong><br />
  Small reminders, everyday lists, and thoughts worth keeping.
</p>

CozyNotes is a quiet desktop notes app with soft paper colors and a cozy place to write. Keep a note beside your work, find an old idea in your library, or tick off a little list. Your notes stay on your device, and the app works offline without an account. Fonts are bundled locally, too.

## Make yourself at home

- **Room to think.** Open notes in their own windows and let autosave take care of your writing.
- **A little structure.** Use rich text, bullet lists, and checklists. Reset completed items when a list needs a fresh start.
- **Find things again.** Search your library, filter by paper color, or find a word inside a note.
- **Pick your paper.** Choose Cream, Butter, Sage, Rose, Lavender, or Mist.
- **Set the mood.** Choose Warm, Night, or System. Your preference is remembered and shared across open windows.
- **Keep what matters.** Duplicate a useful note or restore one from Trash before deleting it for good.

## Settle in

Create a note from the library and start writing. Drag the library by its heading or branding; drag a note using empty space along its toolbar or footer. Closing a note saves it and keeps it in your library.

Use `Ctrl` on Windows/Linux or `Cmd` on macOS:

| Shortcut | A little help |
| --- | --- |
| Ctrl/Cmd + N | New note |
| Ctrl/Cmd + W | Close the current note |
| Ctrl/Cmd + F | Find in a note, or search from the library |
| Ctrl/Cmd + Shift + F | Open library search from a note |
| Ctrl/Cmd + + / - | Adjust note reading size |
| Ctrl/Cmd + 0 | Reset note reading size |

## Growing gently

CozyNotes is in early development, currently **0.1.0**. Windows has received local desktop testing; macOS and Linux still need native interaction testing. The project includes automated CI checks for all three platforms.

Image attachments, remembered window arrangements, user-facing backup and restore, and exports are still on the wish list. Signed installers and automatic release publishing are not configured yet. For now, build the app from source using the steps below.

## Run it locally

Built with Tauri 2, React, TypeScript, and Rust. Use Node.js **24.15.0 or a newer 24.x release**, npm, stable Rust, and the native prerequisites for your platform:

- **Windows:** Microsoft C++ Build Tools with the Desktop development with C++ workload, the Windows SDK, WebView2 Runtime, and the MSVC Rust toolchain.
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

`npm run dev` opens the frontend alone. Saving notes and managing desktop windows require the Tauri runtime.

<details>
<summary>Builds, checks, and Windows network shares</summary>

Run the automated checks:

```sh
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Build a desktop executable with `npm run tauri build -- --no-bundle`, or create platform-specific installers with `npm run tauri build`.

Build output goes to `src-tauri/target/` (or `CARGO_TARGET_DIR` when set). Executables are under `release/`; installers are under `release/bundle/`. Keep copies of packaged builds and other release files in the local **`releases/`** folder at the repository root. That folder and everything inside it are ignored by Git.

On Windows, a local checkout is easiest. For an SMB/UNC checkout, map the repository to a drive and run commands there. Keep Rust build output on a local disk:

```powershell
$env:CARGO_TARGET_DIR = "$env:TEMP\cozynotes-target"
npm run tauri dev
```

See the [Everyday Use verification record](docs/everyday-use-verification.md) for earlier desktop checks, search measurements, and testing limits. Automated checks do not replace native interaction or installer testing.

</details>

## Your notes live here

Notes are stored in `data/cozynotes.sqlite` inside Tauri's per-user app-local-data directory for `com.cozynotes.app`, separate from the project folder. Existing libraries receive a safety snapshot in a sibling `recovery/` directory before a database migration. These snapshots are separate from the planned user-facing backup feature.

For isolated desktop testing, debug builds accept an absolute local `COZYNOTES_TEST_DATA_DIR`; release builds ignore it. Keep personal notes, databases, and private screenshots out of commits and issue reports.

## Lend a hand

Bug reports, small improvements, and thoughtful ideas are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). The [design notes](design.md) describe the colors, typography, and quiet interactions that make CozyNotes feel like home.

Made available under the [MIT License](LICENSE). Bundled fonts and dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
