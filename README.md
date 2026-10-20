<p align="center">
  <img src="src/assets/cozynotes-logo.png" alt="CozyNotes — a little cat with a notebook" width="320" />
</p>

<h1 align="center">CozyNotes</h1>

<p align="center">
  <strong>A little home for your notes.</strong>
</p>

CozyNotes is an offline desktop notes app for Windows x64. Write in floating notes, organize lists, and find ideas in a searchable library. Your notes stay on your device. No account needed.

Windows x64 is the current development, testing, and release target. macOS and Linux support is on hold as of October 19, 2026.

See the [Windows support scope and verification record](docs/2026-10-19-windows-support.md) for the delivery changes and local checks.

**[Download CozyNotes](https://github.com/JayM3/CozyNotes/releases/latest)** · Early development, v0.2.6

- Rich text, checklists, images, ink drawings, and autosave.
- Colored paper, light and dark themes, and favorites.
- Foldable notes, saved window layouts, Trash, and note history.
- In-app update checks and one-click installation from Settings.

<details>
<summary>Features</summary>

- **Writing:** Rich text, bullet lists, resettable checklists, and local images added by paste, drop, or file picker. Fonts are bundled locally.
- **Ink drawings:** Write directly on the note body with a Windows pen, alongside typed text. The pen button opens **Drawing tools** with four colors, three widths, a stroke eraser, undo/redo, and optional **Draw with mouse**. Fingers scroll; ordinary mouse input edits text. Drawing descriptions are searchable, and ink remains editable after saving, duplicating, or restoring history. Existing inline ink drawings are preserved.
- **Organization:** Library search, in-note find, paper-color filters, favorites, duplication, and bulk Trash actions. Favorites appear first; the Favorites only filter combines with search and paper colors.
- **Appearance:** Cream, Butter, Sage, Rose, Lavender, or Mist paper, with Warm, Night, or System themes shared across windows.
- **Windows:** Independent notes with autosave, folding, and remembered sizes and toolbar heights. New notes start at 305 by 385. On Windows, notes snap to desktop edges and neighboring notes, including matching a neighbor's size.
- **Keep on top:** Pin a note above ordinary windows from its toolbar. This resets when the note window closes.
- **Remember my desk:** Reopen notes left open at exit with their sizes, supported positions, and folded state. Individually closed notes stay closed. Automatic reopening can be disabled in Settings.
- **History and recovery:** Preview up to 100 earlier saved versions from **More > Note history**, including formatting and images. Restore a version as a new note, or recover deleted notes from Trash before permanent deletion.
- **Background access:** Use the system tray to open notes, show the main menu, or exit. Run in background is enabled by default and can be changed in Settings.

</details>

<details>
<summary>Using CozyNotes and keyboard shortcuts</summary>

Create a note from the library and start writing. Drag the library by its heading or branding; drag a note using empty space along its toolbar or footer. Closing a note saves it and keeps it in your library.

Fold a note with the footer arrow or **More > Fold note**. The folded title strip can be moved, unfolded, or closed. Resize the toolbar with its bottom handle.

Windows notes snap to all four desktop work-area edges, clear of the taskbar, and to the sides of other visible CozyNotes notes. Adjacent notes can also align their top, bottom, left, or right edges. Snapping catches within 10 logical pixels and releases beyond 22 logical pixels; distances follow display scaling. Minimized, hidden, and other virtual-desktop notes are excluded. The library is not a snap target.

When resizing notes that touch, left/right handles can snap to a neighbor's width, top/bottom handles to its height, and corners to both. The opposite edges stay anchored. Resize snapping uses notes touching at the start of the gesture and respects the minimum note size.

Double-click a note's left or right border to reset its width to 305 logical pixels, or its top or bottom border to reset its height to 385 logical pixels. Double-clicking a corner resets both dimensions. The opposite edges stay anchored, and the reset size is remembered with the note's window arrangement.

With Run in background enabled, closing the main window keeps CozyNotes available from its icon beside the Windows clock. Right-click that icon for **Notes**, **Show main menu**, and **Exit CozyNotes**. Exit waits for open drafts to save; if a draft cannot save, it stays open for recovery.

The **Settings** button in the sidebar opens appearance, background, and Remember my desk preferences in the right pane. These preferences are remembered. Turn off Run in background to exit normally when the last window closes.

Select a note using its circle without opening it. The selection bar shows the count and provides **Select all**, **Clear selection**, and **Move to Trash**. In Trash, **Delete selected** asks for confirmation before permanently deleting the selection. Changing the search, paper-color filter, or page clears the selection.

Write with your pen directly on the note body. Open the pen button for drawing tools, or choose **More > Drawing tools**. Turn on **Draw with mouse** to sketch with a mouse, and turn it off to return to text selection. Fingers scroll without drawing. Ink stays at its paper coordinates when text reflows or the window resizes, and follows the note when it scrolls. It is stored locally as vector strokes, including pressure and tilt; handwriting recognition is not included. See the [direct note inking verification record](docs/2026-10-20-inline-note-ink.md) for behavior, limits, and checks.

Use `Ctrl` for keyboard shortcuts:

| Shortcut | A little help |
| --- | --- |
| Ctrl + N | New note |
| Ctrl + W | Close the current note |
| Ctrl + F | Find in a note, or search from the library |
| Ctrl + Shift + F | Open library search from a note |
| Ctrl + + / - | Adjust note reading size |
| Ctrl + 0 | Reset note reading size |

</details>

<details>
<summary>Windows downloads</summary>

Choose a download from [GitHub Releases](https://github.com/JayM3/CozyNotes/releases/latest):

| Platform | Download |
| --- | --- |
| Windows x64 | `Cozynote.exe` to run directly, or the `windows_x64_setup.exe` installer |

The Windows executable requires WebView2 Runtime, which the installer can install when needed. Older macOS and Linux downloads are historical builds; support and new packages for those platforms are on hold.

Windows downloads are not signed with a publisher certificate. Windows has received local desktop testing. Release builds and automated checks target Windows x64 on GitHub Actions. Each release includes `SHA256SUMS.txt` for checking downloaded files.

User-facing backup, restore, and export are not yet available.

</details>

<details>
<summary>Build from source and development checks</summary>

Built with Tauri 2, React, TypeScript, and Rust. Development targets Windows x64. Use Node.js **24.15.0 or a newer 24.x release**, npm, stable Rust, and these Windows prerequisites:

- Microsoft C++ Build Tools with the Desktop development with C++ workload and the Windows SDK.
- WebView2 Runtime.
- The MSVC Rust toolchain.

From the repository root:

```sh
npm ci
npm run tauri dev
```

`npm run dev` opens the frontend alone. Saving notes and managing desktop windows require the Tauri runtime.

Run the automated checks:

```sh
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Build a Windows executable with `npm run tauri build -- --no-bundle`, or create the Windows NSIS installer with `npm run tauri build`.

To publish a release, synchronize the versions in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`; add `docs/releases/v<VERSION>.md`; then push the matching `v<VERSION>` tag after CI passes. The release workflow tests and builds Windows x64, then publishes the standalone executable, NSIS installer, signed updater, checksums, and a Windows-only updater manifest. Configure the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and, when applicable, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` before publishing the first update-enabled release. The private key must match the public key in `src-tauri/tauri.conf.json` and must never be committed.

Build output goes to `src-tauri/target/` (or `CARGO_TARGET_DIR` when set). Executables are under `release/`; installers are under `release/bundle/`. Keep copies of packaged builds and other release files in the local **`releases/`** folder at the repository root. That folder and everything inside it are ignored by Git.

On Windows, a local checkout is easiest. For an SMB/UNC checkout, map the repository to a drive and run commands there. Keep Rust build output on a local disk:

```powershell
$env:CARGO_TARGET_DIR = "$env:TEMP\cozynotes-target"
npm run tauri dev
```

See the [tray, Settings, and selection verification record](docs/2026-10-17-settings-tray-selection-verification.md) for this feature's checks, and the [Everyday Use verification record](docs/everyday-use-verification.md) for earlier desktop checks and search measurements. Automated checks do not replace native interaction or installer testing.

See the [Keep on top research and verification record](docs/2026-10-18-keep-on-top.md) for the native API decision, platform behavior, and Windows runtime checks. The [desk, favorites, history, and checklist verification record](docs/2026-10-18-desk-favorites-history.md) covers the latest additions.

</details>

<details>
<summary>Local storage, note history, and recovery</summary>

Notes are stored in `data/cozynotes.sqlite` inside Tauri's per-user app-local-data directory for `com.cozynotes.app`, separate from the project folder. Existing libraries receive a safety snapshot in a sibling `recovery/` directory before a database migration. These snapshots are separate from the planned user-facing backup feature.

Note history starts with edits saved by this version; it cannot recover edits made before history was available. Each changed title/body save retains the previous version, up to 100 per note. Unchanged saves, favorites, and window actions do not create versions. Permanently deleting a note also deletes its saved history. Restored notes receive independent copies of their images.

Window sizes, placement, and folding are remembered separately from note content. Automatic reopening is enabled by default. Windows are clamped to current monitor work areas when reopened. Use **Exit CozyNotes** in the tray to save the complete open-note arrangement.

For isolated desktop testing, debug builds accept an absolute local `COZYNOTES_TEST_DATA_DIR`; release builds ignore it. Keep personal notes, databases, and private screenshots out of commits and issue reports.

</details>

[Contributing](CONTRIBUTING.md) · [Design notes](design.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Made available under the [MIT License](LICENSE). Bundled fonts and dependencies keep their own licenses.
