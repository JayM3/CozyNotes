import { useCallback, useMemo, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditorState } from "@tiptap/react";
import { Eraser, PenLine, Redo2, Trash2, Undo2, X } from "lucide-react";
import { InkCanvas } from "./InkNode";
import { inkColors, isInkDrawing, MAX_DOCUMENT_INK_POINTS, MAX_INK_DRAWINGS } from "./ink";
import type { InkStroke } from "./ink";
import { finishActiveInk, registerInkSession } from "./inkSession";
import { commitNoteInk, documentInkUsage, emptyNoteInk, noteInkBounds } from "./noteInk";

export type NoteInkTools = { tool: "pen" | "eraser"; color: string; width: number; mouse: boolean };
export const defaultNoteInkTools: NoteInkTools = { tool: "pen", color: inkColors[0].value, width: 4, mouse: false };

export function NoteContent({ editor, editable = false, tools = defaultNoteInkTools }: { editor: Editor | null; editable?: boolean; tools?: NoteInkTools }) {
  const surface = useRef<HTMLDivElement>(null);
  const stored = useEditorState({ editor, selector: ({ editor: current }) => current?.state.doc.attrs.ink ?? null });
  const drawing = useMemo(() => isInkDrawing(stored) ? stored : emptyNoteInk(), [stored]);
  const bounds = useMemo(() => noteInkBounds(drawing), [drawing]);
  const canEdit = useCallback(() => editable && Boolean(editor?.isEditable), [editor, editable]);
  const remainingPoints = useCallback(() => {
    if (!editor) return 0;
    const usage = documentInkUsage(editor.state.doc);
    if (!editor.state.doc.attrs.ink && usage.drawings >= MAX_INK_DRAWINGS) return 0;
    return MAX_DOCUMENT_INK_POINTS - usage.points;
  }, [editor]);
  const onCommit = useCallback((strokes: InkStroke[]) => {
    if (!editor) return false;
    const next = { ...drawing, strokes };
    return commitNoteInk(editor, strokes.length || drawing.description ? next : null);
  }, [editor, drawing]);
  const registerFinish = useCallback((finish: () => void) => editor ? registerInkSession(editor, finish) : () => {}, [editor]);

  return <div ref={surface} className={`note-content${tools.mouse ? " is-mouse-drawing" : ""}${tools.tool === "eraser" ? " is-erasing" : ""}`} tabIndex={-1}
    style={{ minWidth: bounds.width, minHeight: bounds.height }} onKeyDownCapture={event => {
      const key = event.key.toLowerCase();
      if (!canEdit() || event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || !["z", "y"].includes(key)
        || (event.target as Element).closest(".ink-node")) return;
      event.preventDefault(); event.stopPropagation();
      finishActiveInk(editor);
      if (event.shiftKey || key === "y") editor?.commands.redo(); else editor?.commands.undo();
    }}>
    <EditorContent editor={editor} className="note-text" />
    <InkCanvas drawing={drawing} {...tools} editable={editable} canEdit={canEdit} remainingPoints={remainingPoints} onCommit={onCommit} registerFinish={registerFinish} surface={surface} />
  </div>;
}

export function NoteDrawingTools({ editor, disabled, tools, onChange, onClose }: {
  editor: Editor | null; disabled: boolean; tools: NoteInkTools; onChange: (tools: NoteInkTools) => void; onClose: () => void;
}) {
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    undo: current?.can().undo() ?? false, redo: current?.can().redo() ?? false,
    drawing: current?.state.doc.attrs.ink ?? null,
  }) });
  const action = (run: () => void) => { if (!disabled && editor?.isEditable) { finishActiveInk(editor); run(); } };
  const change = (patch: Partial<NoteInkTools>) => action(() => onChange({ ...tools, ...patch }));
  return <div id="note-drawing-tools" className="note-drawing-tools" role="group" aria-label="Note drawing tools">
    <div className="ink-controls">
      <button type="button" className={`tool${tools.tool === "pen" ? " active" : ""}`} disabled={disabled} aria-label="Pen" title="Pen" aria-pressed={tools.tool === "pen"} onClick={() => change({ tool: "pen" })}><PenLine size={16} /></button>
      <button type="button" className={`tool${tools.tool === "eraser" ? " active" : ""}`} disabled={disabled} aria-label="Stroke eraser" title="Stroke eraser" aria-pressed={tools.tool === "eraser"} onClick={() => change({ tool: "eraser" })}><Eraser size={16} /></button>
      <label className="ink-setting">Color<select disabled={disabled} value={tools.color} onChange={event => change({ color: event.target.value })}>{inkColors.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}</select></label>
      <label className="ink-setting">Width<select disabled={disabled} value={tools.width} onChange={event => change({ width: Number(event.target.value) })}><option value={2}>Fine</option><option value={4}>Medium</option><option value={8}>Thick</option></select></label>
      <button type="button" className="tool" disabled={disabled || !state?.undo} aria-label="Undo" title="Undo" onClick={() => action(() => { editor?.commands.undo(); })}><Undo2 size={16} /></button>
      <button type="button" className="tool" disabled={disabled || !state?.redo} aria-label="Redo" title="Redo" onClick={() => action(() => { editor?.commands.redo(); })}><Redo2 size={16} /></button>
      <button type="button" className="tool" disabled={disabled || !state?.drawing} aria-label="Clear note ink" title="Clear note ink" onClick={() => action(() => { if (editor) commitNoteInk(editor, null); })}><Trash2 size={16} /></button>
      <label className="ink-mouse"><input type="checkbox" disabled={disabled} checked={tools.mouse} onChange={event => change({ mouse: event.target.checked })} /> Draw with mouse</label>
      <button type="button" className="tool" aria-label="Close drawing tools" title="Close drawing tools" onClick={() => { finishActiveInk(editor); onClose(); }}><X size={16} /></button>
    </div>
    {state?.drawing && <label className="ink-description">Drawing description<input disabled={disabled} value={state.drawing.description} maxLength={240} placeholder="Optional: describe your drawing" onChange={event => action(() => {
      if (editor) commitNoteInk(editor, { ...editor.state.doc.attrs.ink, description: event.target.value });
    })} /></label>}
  </div>;
}
