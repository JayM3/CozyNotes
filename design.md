# CozyNotes Design System

CozyNotes is a playful desktop writing workspace with a calm paper editor. The cat-and-notebook logo is the primary sidebar identity; the smiling notebook mark is used for the native application icon and compact empty states.

Design and interaction validation target Windows x64. macOS and Linux support is on hold as of October 19, 2026. Prioritize Windows window behavior, display scaling, keyboard access, and tray integration.

## Brand

- Sidebar logo: `src/assets/cozynotes-logo.png`
- App icon source: `public/cozynotes-icon.png`
- Accent family: apricot orange, coral, cocoa brown, cream, and sage
- Voice: warm, friendly, quiet while writing

## Theme

The default is `Warm`. Users can choose `Night` or `System` from the Settings page in the main window. The preference is stored as `cozynotes.theme` and synchronized between Tauri windows.

Tokens live in `tokens.css`. Components reference semantic variables rather than individual color values.

The supplied sidebar artwork keeps a light backing in Night mode so its cocoa wordmark stays legible.

## Typography

- Display: Nunito 600/700 for headings and compact labels
- Body: Source Sans 3 for controls, metadata, and note text
- Notes can start in Source Sans 3 or Nunito, with regular, bold, and italic styles bundled locally. Note fonts apply to writing surfaces and titles; application controls retain their own fonts.
- Note base reading sizes: 12, 14, 16, 18, 20, and 24px. Temporary reading adjustments reset to the note’s saved base when reopened or with Ctrl+0.

## Surfaces

- The library uses a narrow brand rail and a searchable note workspace.
- Settings opens in the right pane, with the rail providing the same Notes and Trash navigation.
- New note defaults sits between Appearance and App behavior, with named paper swatches, font/text-size selects, size presets/custom dimensions, a scaled preview, Save defaults, and a factory reset that fills the draft. Saving snapshots the defaults for future blank notes; existing notes retain their own appearance.
- Default dimensions use logical pixels, from 305–1600 wide and 240–1600 high. Presets are Classic (305 × 385), Roomy (400 × 500), and Large (520 × 640). Actual windows fit the monitor; explicit border-double-click resets use the current saved defaults.
- Circular checkboxes at the right of each row retain the paper color and show a checkmark when selected. Selection actions operate on the current visible results.
- Note windows keep the paper color as the writing canvas and use compact icon controls.
- Existing Cream, Butter, Sage, Rose, Lavender, and Mist note colors remain available.
- Warm and Night theme variants preserve the paper-color choice while adapting contrast.

## Interaction

- Controls use Lucide icons, visible focus rings, and clear disabled states.
- The library and note windows retain their existing keyboard shortcuts and frameless drag regions.
- Motion is short and quiet, with reduced-motion fallbacks.
- A native system tray menu provides Notes, Show main menu, and Exit CozyNotes. Background operation is enabled by default, with a remembered setting.
- Exit and bulk trash wait for affected drafts to save before closing their note windows; a failed save cancels the operation.
