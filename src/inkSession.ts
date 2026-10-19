import type { Editor } from "@tiptap/core";

const sessions = new WeakMap<Editor, Set<() => void>>();

export function registerInkSession(editor: Editor, finish: () => void) {
  let current = sessions.get(editor);
  if (!current) { current = new Set(); sessions.set(editor, current); }
  current.add(finish);
  return () => { current.delete(finish); };
}

/** Commit wet ink synchronously before the note's existing save/close barrier. */
export function finishActiveInk(editor: Editor | null) {
  if (editor && !editor.isDestroyed) sessions.get(editor)?.forEach(finish => finish());
}
