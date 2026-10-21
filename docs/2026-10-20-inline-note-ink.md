# Drawing directly on notes

Recorded October 20, 2026. Windows x64 implementation on branch `inline-note-ink`.

## Behavior

A pen draws immediately on the note body without inserting an ink attachment. Mouse clicks still place the text cursor, select text, and operate checklists; fingers scroll. The pen button opens drawing tools: four colors, three widths, whole-stroke erasing, undo/redo, clear ink, and a Draw with mouse checkbox. Closing the tools preserves the selected input mode. Existing inline ink attachments remain editable.

Typed text and ink coexist. Strokes use paper coordinates independent of window size and text reading size, and move with the note when it scrolls. Narrowing the note preserves drawing coordinates and allows overflow within the note body. Changing or reflowing text does not attach strokes to words. Night theme adapts stroke display while retaining stored colors.

The drawing area is bounded to 4,096 by 4,096 CSS pixels from the note body's origin. The canvas bitmap covers the visible layout extent, not that entire coordinate space, and is capped at approximately eight million pixels. Beyond the drawing extent, the note reports its drawing limit. Existing stroke/point/document budgets still apply; note ink and legacy attachments share the note budget.

## Storage and Lifecycle

`CozyDocument` stores optional versioned vector ink in the root document's `attrs.ink`. Rust validates it with the existing strict ink validator and shared aggregate limits. Text-only documents omit the attribute, including after clearing ink, preserving their earlier format. No database schema migration or IPC permission is needed. Older app versions cannot edit documents with note-level ink; their existing recovery checks prevent overwriting unsupported content.

Completed strokes are normal TipTap document transactions with one undo event per gesture. Wet ink is finished synchronously by the existing save/close barrier. Blur, visibility changes, cancellation, lost capture, scrolling, and resizing also commit interrupted strokes. Autosave, revision checks, history, duplication, Trash, and restoration retain ink with text. Descriptions already saved on older drawings remain in recovery text and library search.

`loadNoteDocument` explicitly restores root attributes: TipTap's `setContent` replaces the document fragment but does not restore root attributes. This was caught by native close/reopen verification and is regression-tested. Loading does not emit an edit or create an undo step.

## Sticky Notes Reference

The installed Microsoft Sticky Notes package was version 6.1.4.0. Its main DLL hash matched the earlier REA investigation: `4d874a74b8a0d2d19f7c46092ac62b9ad2a6ef64392c75fc4064fe9af3bb9cc3`.

The package contains `InkView.xbf`, `InkRendering.xbf`, `InkCanvas`, `InkPresenter`, and stroke container/event names. Its two packaged warnings say "Create a new note to draw or write" and "Create a new note to type", suggesting separate ink and text modes in that version. CozyNotes deliberately supports both on one note.

These are static observations and inferences. Exact native methods and input routing were not decompiled because no native REA provider was configured; Sticky Notes was not launched. Retained REA records were revalidated through REA 6.4.0 and supplemented with a Windows SDK PRI resource dump. Full evidence, offsets, hashes, and limitations are in the workspace's `Plan/2026-10-20-inline-ink-research.md` and `Plan/evidence/inline-ink-findings.json`.

The implementation uses CozyNotes' Pointer Events renderer in WebView2. It does not embed Microsoft's control or implement handwriting recognition. On Windows, the WebView2 handwriting-to-text feature is disabled so pen strokes remain vector ink while keyboard text editing stays available.

## Verification

Final automated checks: **153 frontend tests in 18 files**, **92 Rust tests passed with one existing benchmark ignored**, TypeScript and the production frontend build, Rust formatting, patch whitespace, and the Windows debug native build all passed. The build retains Vite's existing bundle-size warning. Tests ran in an isolated local copy to avoid SMB toolchain behavior; all 65 files under `src` and `src-tauri/src` were hash-compared with the workspace and matched.

Automated coverage includes direct pen input, mouse opt-in, touch exclusion, simulated palm contacts, pressure/tilt, erasure, independent undo/redo, interrupted strokes, scroll coordinates, read-only rendering, restored root attributes, text-only compatibility, shared budgets, and existing inline attachments. Rust tests cover validation, search/recovery descriptions, history, copying, Trash, and persistence across database reopen.

Windows native verification used an isolated app identifier and `COZYNOTES_TEST_DATA_DIR`, with Playwright attached to the test app's WebView2. No personal library was used.

Verified in the running app:

- Simulated pen input draws over typed text without inserting an attachment.
- Browser mouse input draws only after opting in; undo/redo retains both strokes.
- Read-back through the app API confirms saved vectors and description text.
- At 305- and 500-pixel viewport widths, rendered ink had the same 748 nontransparent pixels and the same pixel bounds; no page overflow.
- Warm and Night rendering, fold/unfold, duplication, and close/reopen preserve ink.
- Closing with Ctrl+W during a mouse stroke saves the partial stroke.
- Read-only history renders ink, and restoring a version creates an independent note with matching strokes.
- Simulated touch input scrolled 101 pixels without modifying ink. A pen stroke after scrolling was stored at its paper coordinates and persisted after closing.
- Trash and restoration preserve the saved document.
- With Vite stopped, the standalone executable opened its bundled frontend at `http://tauri.localhost`, loaded all four saved strokes, and rendered 1,182 nontransparent ink pixels. The smoke-test note then closed through the normal save path.

Windows: Windows 11 Pro Insider Preview, build 26220. Physical pen pressure, hardware palm rejection, digitizer latency, screen-reader use, and installer/publishing behavior were not verified. The tests simulate pen and touch events and do not replace hardware testing.

Local screenshots are in `output/playwright/inline-note-ink/`. An uncommitted standalone Windows debug preview is in `releases/inline-ink-preview/CozyNotes-inline-ink-preview.exe` (SHA-256 `8586e1b3ab96323efb31a9387a6b5d4d566774c461145525655a1fb5d7aa44f0`). Its app identifier is `com.cozynotes.inlineinkverification`, keeping its default data separate from the installed app. This preview is not a published release or installer. Test windows and the temporary dev server were closed after verification.
