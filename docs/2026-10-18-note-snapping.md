# Note snapping

Implemented in the working tree for CozyNotes 0.2.2. This is the verification record for the release changes.

## Behavior

- Windows notes magnetically align during a native drag from their existing toolbar, footer, or folded title strip.
- All four display work-area edges and the adjacent sides of other visible note windows are targets. Work areas leave room for the taskbar. Adjacent notes can align into rows and columns; display corners can snap on both axes.
- Capture distance is 10 logical pixels; an existing snap holds until the raw pointer position moves more than 22 logical pixels away. Distances follow the dragged window's DPI. Continuing the same drag releases the snap.
- Moving notes retain their size and remain independent. Snapping creates no group or persistent attachment. Folded notes participate using their current dimensions.
- Resizing a note touching another note can snap to the neighbor's visible width and height. All four borders and four corner handles participate; only the dragged borders move, and the opposite borders stay anchored. The stationary note is not resized or moved.
- Resize targets are notes touching at the beginning of the gesture (within two logical pixels to allow for native rounding). All four neighbor sides qualify. Width/height matching uses the same capture/release distances as movement, follows DPI, and respects the expanded note minimum of 305 by 240 logical pixels. Folded targets can supply a width but cannot shrink an expanded note below its minimum height.
- Hidden, minimized, and DWM-cloaked notes are excluded. Only note windows in this application's UI thread participate; the library and other applications are excluded.
- Snapping runs during native movement and border resizing. Folding retains its existing behavior. Final coordinates and dimensions use the existing desk placement persistence. Windows restoration fits the visible paper after native frame insets settle, preserving flush left/top alignment across reopening.
- Windows note maximization is disabled to keep native display-edge gestures from resizing notes. Manual resizing remains available for expanded notes.
- macOS and Linux retain their existing native window dragging.

## Implementation

The Windows adapter installs a common-controls subclass on each note's UI thread. It modifies the proposed `WM_MOVING` or `WM_SIZING` rectangle before the operating system applies it, using client bounds to exclude invisible native borders. It does not issue recursive position or size changes from window events. The original cursor offsets are retained in logical coordinates for all four borders, so snapped positions and dimensions do not accumulate into the pointer anchor. State is reset at the beginning/end of each gesture and released on native window destruction. Resizing snapshots adjacent window handles at the start and rechecks their visibility and dimensions on each message; a hidden or closed neighbor stops being a target.

The geometry module is independent of Windows APIs. It selects compatible X/Y targets together, retains valid existing snaps, then favors both-axis capture and least movement. Ties are deterministic regardless of window enumeration order. Note adjacency requires a positive shared span; distant parallel edges and diagonal point contacts do not attract each other.

## Verification

- Rust suite: 82 passed, one existing synthetic benchmark ignored. Includes 24 movement geometry tests, nine resize geometry tests, seven Windows native message/lifecycle tests, and two placement tests for restoring visible snapped edges with native frame offsets.
- Native tests create disposable Win32 windows and exercise the actual subclass through `WM_MOVING` and `WM_SIZING`. They cover all eight resize handles with all four neighbor sides, visible dimension matching with nonzero native frame insets, stationary targets, hidden/unrelated target exclusion, initial adjacency, folded-size preservation, raw-pointer hysteresis/reset, idempotent installation, and destruction cleanup. Synthetic cursor input makes the tests independent of the user's live mouse movement.
- Geometry tests cover all edges, corners, pull-away in either direction, deterministic target selection, disappearing targets, display scaling, negative monitor origins, monitor seams, folded notes, and dimension preservation.
- Frontend production build, Rust formatting, and tracked diff whitespace checks pass.
- Optimized Windows x64 build passes with the bundled frontend and the existing release-only unused `env` import warning in `assets.rs`. The earlier movement-only executable is in the ignored `releases/CozyNotes-0.2.1-snapping-windows-x64.exe`; the verified combined movement/resize build is `releases/CozyNotes-0.2.1-snapping-resize-windows-x64.exe`.

Physical pointer dragging in the complete Tauri application, mixed-DPI monitor transitions, and other operating systems were not manually exercised. Native message tests verify the handler but do not replace those desktop checks.
