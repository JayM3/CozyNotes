# Keep on top research and verification

Date: October 18, 2026.

Scope: the note-window **Keep on top** control. The control changes the native stacking state of the current note window. It is separate from the note document, autosave, database revision, and library ordering.

## Research conclusion

CozyNotes uses Tauri's native window API. The frontend reads the current state with `getCurrentWindow().isAlwaysOnTop()` and changes it with `setAlwaysOnTop(true)` or `setAlwaysOnTop(false)`. This avoids a platform-specific Windows implementation and keeps the behavior tied to the native window that owns the note.

Sources:

- [Tauri window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/): `isAlwaysOnTop()` reads the native state and `setAlwaysOnTop()` changes it.
- [Windows `SetWindowPos` documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos): a topmost window remains above ordinary windows even when it is inactive; another topmost window can still cover it.
- [Tao window documentation](https://docs.rs/tao/0.37.1/tao/window/struct.Window.html): always-on-top support is available through the native window abstraction, while Linux X11 support is advisory and Wayland support is unavailable for this operation.

## Platform behavior

The existing `platform_capabilities` command reports whether this operation is available in the current desktop session:

- Windows: available.
- macOS: available.
- Linux X11: exposed to the window manager; the result depends on the desktop environment.
- Linux Wayland: unavailable. The button remains visible and discoverable, but it has `aria-disabled="true"` and explains that the feature is unavailable in the current desktop session.

The `note-window` capability grants `core:window:allow-set-always-on-top` only to `note-*` windows. The state getter is provided by the existing default window permissions. No new backend command or persistence field is required.

## User behavior

- The pin button appears immediately before Paper color in every note toolbar.
- Its accessible name remains `Keep on top`; `aria-pressed` reflects the current state.
- The tooltip says `Keep on top` when the note is unpinned and `Stop keeping on top` when it is pinned.
- The setting belongs to the native note window. New and duplicated notes start unpinned, closing and reopening a note resets it, and reopening an already-open note preserves that window's current state.
- Initialization reads the native state before enabling the control. Toggle requests are serialized, and the displayed state changes only after `setAlwaysOnTop()` succeeds.
- A failed toggle leaves the prior state visible and shows a separate retryable error. Initialization failures provide a Retry action. Pin errors do not enter the document-save error path.
- The button prevents the toolbar mouse-down from moving focus away from the editor, so selection and toolbar dragging behavior remain unchanged. Toggling does not run a focus timer or restore focus to the editor.

## Automated verification

The focused Keep on top suite covers:

- initialization from `isAlwaysOnTop()`;
- initialization failure and Retry;
- setter failure, state preservation, and Retry;
- rapid repeated activation while a native setter is pending;
- unsupported sessions and the accessible explanation;
- independent state in two note windows;
- disabled behavior while the note is loading or locked.

The final frontend suite passed 100 tests across 12 files. The frontend production build passed. Rust formatting passed, and Rust tests passed with 30 tests; the one ignored benchmark was pre-existing.

## Windows runtime verification

The feature was exercised in an isolated Windows debug application using the unique identifier `com.cozynotes.keepontop.test` and synthetic data under `C:\Users\jayem\AppData\Local\Temp\cozynotes-everyday-test-keep-on-top-20261018`. WebView2/CDP inspection attached only to that isolated instance; the user's installed CozyNotes process and notes were left untouched.

Observed results:

- The initial state was unpinned.
- Activating the button changed `aria-pressed` to `true` and the tooltip to `Stop keeping on top`.
- Editor focus remained on `Note text` after pinning.
- A second note kept an independent native state.
- Unpinning restored ordinary stacking.
- Closing and reopening the note reset it to unpinned.
- Reopening an already-open note preserved its pinned state.
- The user then switched to another application and typed there while the pinned note remained visible; unpinning restored normal stacking.

The normal release check was run with:

```powershell
$env:CARGO_TARGET_DIR = "$env:TEMP\\cozynotes-target"
Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue
npm run tauri build -- --no-bundle
```

## Verification limits

The Windows behavior was verified on a native desktop. Browser-only tests cannot establish window stacking. macOS and Linux native desktop interaction was not exercised in this environment, so the X11 window-manager behavior and Wayland unavailability remain documented from the platform APIs and the existing capability detection. Packaging, signing, and installer behavior were outside this feature check.
