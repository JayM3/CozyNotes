import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";

export const paperColors = ["cream", "butter", "sage", "rose", "lavender", "mist"] as const;
export type PaperColor = typeof paperColors[number];
export type View = "notes" | "trash";
export type SnippetSegment = { text: string; matched: boolean };
export type NoteSummary = {
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
export type LibraryFilter = { query: string; color: PaperColor | null };
export type AppSettings = { runInBackground: boolean; trayAvailable: boolean; warning: string | null };

export const notesApi = {
  list: (trashed: boolean, query: string, color: PaperColor | null) =>
    invoke<NoteSummary[]>("list_notes", { trashed, query, color }),
  get: (id: string) => invoke<Note>("get_note", { id }),
  create: () => invoke<Note>("create_note"),
  open: (id: string) => invoke<void>("open_note", { id }),
  save: (id: string, expectedRevision: number, draft: NoteDraft) =>
    invoke<Note>("save_note", { id, expectedRevision, ...draft }),
  color: (id: string, color: PaperColor) => invoke<void>("set_note_color", { id, color }),
  duplicate: (id: string) => invoke<Note>("duplicate_note", { id }),
  trash: (id: string) => invoke<void>("trash_note", { id }),
  restore: (id: string) => invoke<void>("restore_note", { id }),
  purge: (id: string) => invoke<void>("purge_note", { id }),
  emptyTrash: () => invoke<void>("empty_trash"),
  getSettings: () => invoke<AppSettings>("get_settings", {}),
  takeAppError: () => invoke<string | null>("take_app_error", {}),
  setRunInBackground: (enabled: boolean) => invoke<AppSettings>("set_run_in_background", { enabled }),
  trashMany: (ids: string[]) => invoke<void>("trash_notes", { ids }),
  purgeMany: (ids: string[]) => invoke<void>("purge_notes", { ids }),
  showLibrary: (focusSearch = false) => invoke<void>("show_library", { focusSearch }),
};
