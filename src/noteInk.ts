import { Node } from "@tiptap/core";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { isInkDrawing, MAX_DOCUMENT_INK_POINTS, MAX_INK_DRAWINGS, pointCount } from "./ink";
import type { InkDrawing } from "./ink";

// A fixed paper coordinate space keeps ink in place when text reflows or the
// window changes size. The canvas bitmap only covers the rendered note body.
export const NOTE_INK_SIZE = 4096;
export const emptyNoteInk = (): InkDrawing => ({ version: 1, width: NOTE_INK_SIZE, height: NOTE_INK_SIZE, description: "", strokes: [] });

export const CozyDocument = Node.create({
  name: "doc", topNode: true, content: "block+",
  addAttributes() { return { ink: { default: null, rendered: false } }; },
});

export function loadNoteDocument(editor: Editor, document: JSONContent) {
  editor.schema.nodeFromJSON(document).check();
  // TipTap's setContent replaces the document fragment, not root attributes.
  editor.chain().setContent(document, { emitUpdate: false, errorOnInvalidContent: true })
    .command(({ tr }) => { tr.setDocAttribute("ink", document.attrs?.ink ?? null); return true; })
    .setMeta("addToHistory", false).run();
}
export function getNoteDocument(editor: Editor) {
  const document = editor.getJSON();
  // Text-only notes keep their original format, including after ink is cleared.
  if (document.attrs?.ink == null) delete document.attrs;
  return document;
}
export function documentInkUsage(document: DocumentNode) {
  const ink = document.attrs.ink;
  let drawings = isInkDrawing(ink) ? 1 : 0;
  let points = isInkDrawing(ink) ? pointCount(ink.strokes) : 0;
  document.descendants(node => {
    if (node.type.name === "ink") { drawings++; points += pointCount(node.attrs.strokes); }
  });
  return { drawings, points };
}

export function commitNoteInk(editor: Editor, drawing: InkDrawing | null) {
  if (editor.isDestroyed || !editor.isEditable || (drawing !== null && !isInkDrawing(drawing))) return false;
  const current = editor.state.doc.attrs.ink as InkDrawing | null;
  const usage = documentInkUsage(editor.state.doc);
  if (usage.drawings - (current ? 1 : 0) + (drawing ? 1 : 0) > MAX_INK_DRAWINGS
    || usage.points - (current ? pointCount(current.strokes) : 0) + (drawing ? pointCount(drawing.strokes) : 0) > MAX_DOCUMENT_INK_POINTS) return false;
  editor.view.dispatch(closeHistory(editor.state.tr.setDocAttribute("ink", drawing)));
  editor.view.dispatch(closeHistory(editor.state.tr));
  return true;
}

/** Ink extends the scrollable paper, rather than stretching with the viewport. */
export function noteInkBounds(drawing: InkDrawing) {
  let width = 0, height = 0;
  for (const stroke of drawing.strokes) for (const point of stroke.points) {
    width = Math.max(width, Math.min(drawing.width, point.x * drawing.width + stroke.width / 2));
    height = Math.max(height, Math.min(drawing.height, point.y * drawing.height + stroke.width / 2));
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

