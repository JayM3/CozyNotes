# Ink drawings: implementation and verification

Recorded October 19, 2026. Development and delivery target Windows x64.

## Using ink

Choose **More > Insert ink drawing** in a note. Notes wider than 365 CSS pixels also show an insertion button with a pen icon. Write on the drawing with a Windows pen, or enable **Draw with mouse**. Touch contacts do not create strokes. The drawing surface captures pen gestures; scroll the note from outside that surface.

Each drawing has four pen colors, three widths, a whole-stroke eraser, undo/redo, deletion, and an optional description. A pen's eraser end selects erasing for that gesture. Descriptions appear in recovery text and library search. The light drawing paper keeps stored colors readable in both application themes.

The feature uses Pointer Events in Windows WebView2. It does not host a native Windows InkPresenter and does not perform handwriting recognition. Pressure controls stroke width; tilt is retained for future tools. Recognition and tilt-dependent brushes are outside this change.

## Content and lifecycle

`CozyInk` is a TipTap block node with versioned JSON attributes. Coordinates are normalized to the drawing's logical width and height; resizing the note redraws the vector content at the current display scale. A cached canvas holds completed strokes, and an animation frame paints wet ink without a React or document update per sample. Coalesced input samples are retained, with very close points filtered out.

Finishing a stroke creates one document change and one independent undo event. Completed ink follows the existing revision-checked autosave, history, duplication, Trash, and restoration paths. A stroke in progress is committed synchronously before close, fold, duplicate, history, or native Trash/exit preparation locks and flushes the editor. Pointer cancellation, capture loss, window blur, and visibility changes also retain partial strokes. Loading a saved document does not create an undo event that could clear the note.

No database migration or new IPC permission is required. The document validator accepts `ink` blocks and rejects unknown fields, unsupported versions, invalid colors, missing attributes, and out-of-range geometry. Limits are shared by convention between `src/ink.ts` and `src-tauri/src/ink.rs`:

| Limit | Value |
| --- | --- |
| Drawings per note | 64 |
| Strokes per drawing | 512 |
| Points per stroke | 8,192 |
| Points per drawing | 50,000 |
| Ink points across a note, including nested blocks | 100,000 |
| Drawing description | 240 Unicode characters |

The UI stops recording at the point budget and explains how to continue. Invalid saves do not change stored documents or create history. Older CozyNotes versions do not understand ink nodes; their existing recovery behavior preserves these documents and prevents overwriting them.

## Verification

Automated checks:

- Frontend: **135 tests passed across 17 files**, including 16 ink tests. Coverage includes pressure and tilt, coalesced samples, touch rejection, optional mouse input, hardware-eraser event mapping, swept erasure, interrupted strokes, point budgets, rapid consecutive strokes, independent undo/redo, HTML round trips, read-only rendering, and the save barrier.
- Rust: **90 tests passed, one existing synthetic benchmark ignored**. Ink coverage includes persistence through restart, history copies, Trash and restoration, description search, invalid input rejection, and aggregate limits across nested blocks.
- TypeScript and production frontend build passed.
- Rust formatting passed.
- Windows debug native build passed with `npm run tauri build -- --debug --no-bundle`.
- Patch whitespace check passed.

Frontend tests ran from an isolated local copy installed with `npm ci`, after the SMB checkout's slow test discovery. Source files were byte-compared with the checkout before the final run. Concurrent library-layout changes in the checkout were included in validation and preserved.

Desktop checks ran in `npm run tauri dev` on **Windows 11 Pro Insider Preview, build 26220**, with **WebView2 156.0.4314.23**. An isolated app identifier and `COZYNOTES_TEST_DATA_DIR` kept verification data separate from the installed application. Playwright connected to that app's WebView2 debugging endpoint. The test app and temporary frontend server were stopped after verification.

Verified in the Windows app:

- Insert a drawing through More at the default note width.
- Draw and save using real browser mouse input, with vector data read back through the application's API.
- Render at 305- and 500-pixel widths without changing stored coordinates.
- Erase two saved strokes with a swept gesture and recover them with Undo.
- Preview historical ink without editing controls; restore it as a new note.
- Duplicate an ink note, close it, reopen it, and confirm saved strokes.
- Fold and unfold an ink note and render it in Night theme.
- Close with **Ctrl+W while a mouse stroke is still in progress**, then read the saved note from the library and confirm the partial stroke was retained.

Physical Windows pen pressure, hardware eraser behavior, palm behavior on actual digitizers, and a screen reader session were **not verified**. Pen event behavior is covered by automated Pointer Event tests. Installer packaging, publishing, and migration between app versions were outside this check.
