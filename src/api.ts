import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";

export const paperColors = ["cream", "butter", "sage", "rose", "lavender", "mist"] as const;
export type PaperColor = typeof paperColors[number];
export type View = "notes" | "trash";
export type SnippetSegment = { text: string; matched: boolean };
export type NoteSummary = {
  favorite: boolean;
  id: string;
  title: string;
  preview: string;
  color: PaperColor;
  revision: number;
  updatedAt: number;
  snippet: SnippetSegment[];
};
export type Note = Omit<NoteSummary, "snippet"> & {
  explicitTitle: string;
  document: JSONContent | null;
  documentError?: string | null;
  plainText: string;
};
export type NoteDraft = { document: JSONContent; explicitTitle: string };
export type SavedImageAsset = { assetId: string; mimeType: string };
export type LibraryFilter = { query: string; color: PaperColor | null };
export type AppSettings = { runInBackground: boolean; rememberDesk: boolean; openOnStartup: boolean; trayAvailable: boolean; warning: string | null };
export const sourceCodeUrl = "https://github.com/JayM3/CozyNotes";
export type NoteWindowState = { width: number; height: number; x: number | null; y: number | null; folded: boolean; isOpen: boolean };
export type HistoryEntry = { revision: number; savedAt: number; title: string; preview: string };
export type HistoryVersion = Omit<HistoryEntry, "preview"> & { document: JSONContent; explicitTitle: string; plainText: string; color: PaperColor };
export type PlatformCapabilities = { absoluteWindowPosition: boolean; alwaysOnTop: boolean };

export const notesApi = {
  favorite: (id: string, favorite: boolean) => invoke<void>("set_note_favorite", { id, favorite }),
  history: (id: string) => invoke<HistoryEntry[]>("list_note_history", { id }),
  historyVersion: (id: string, revision: number) => invoke<HistoryVersion>("get_note_history", { id, revision }),
  restoreHistory: (id: string, revision: number) => invoke<Note>("restore_note_history", { id, revision }),
  getWindowState: () => invoke<NoteWindowState>("get_note_window_state"),
  setFolded: (folded: boolean) => invoke<NoteWindowState>("set_note_folded", { folded }),
  setRememberDesk: (enabled: boolean) => invoke<AppSettings>("set_remember_desk", { enabled }),
  setOpenOnStartup: (enabled: boolean) => invoke<AppSettings>("set_open_on_startup", { enabled }),
  list: (trashed: boolean, query: string, color: PaperColor | null) =>
    invoke<NoteSummary[]>("list_notes", { trashed, query, color }),
  get: (id: string) => invoke<Note>("get_note", { id }),
  create: () => invoke<Note>("create_note"),
  open: (id: string) => invoke<void>("open_note", { id }),
  save: (id: string, expectedRevision: number, draft: NoteDraft) =>
    invoke<Note>("save_note", { id, expectedRevision, ...draft }),
  saveImage: (mimeType: string, bytes: number[]) =>
    invoke<SavedImageAsset>("save_image_asset", { mimeType, bytes }),
  deleteImage: (assetId: string) => invoke<void>("delete_image_asset", { assetId }),
  color: (id: string, color: PaperColor) => invoke<void>("set_note_color", { id, color }),
  duplicate: (id: string) => invoke<Note>("duplicate_note", { id }),
  trash: (id: string) => invoke<void>("trash_note", { id }),
  restore: (id: string) => invoke<void>("restore_note", { id }),
  purge: (id: string) => invoke<void>("purge_note", { id }),
  emptyTrash: () => invoke<void>("empty_trash"),
  getSettings: () => invoke<AppSettings>("get_settings", {}),
  getPlatformCapabilities: () => invoke<PlatformCapabilities>("platform_capabilities", {}),
  takeAppError: () => invoke<string | null>("take_app_error", {}),
  setRunInBackground: (enabled: boolean) => invoke<AppSettings>("set_run_in_background", { enabled }),
  trashMany: (ids: string[]) => invoke<void>("trash_notes", { ids }),
  purgeMany: (ids: string[]) => invoke<void>("purge_notes", { ids }),
  showLibrary: (focusSearch = false) => invoke<void>("show_library", { focusSearch }),
};
