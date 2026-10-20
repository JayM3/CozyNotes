import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { Eraser, PenLine, Redo2, Trash2, Undo2 } from "lucide-react";
import { emptyInk, inkColors, inkPoint, isInkDrawing, MAX_DOCUMENT_INK_POINTS, MAX_DRAWING_POINTS, MAX_INK_DRAWINGS, MAX_INK_STROKES, MAX_STROKE_POINTS, paintStroke, pointCount, strokeHitsEraser } from "./ink";
import type { InkDrawing, InkPoint, InkStroke } from "./ink";
import { finishActiveInk, registerInkSession } from "./inkSession";
import { documentInkUsage } from "./noteInk";

// Tauri's save barrier changes editability without emitting a document update.
export const InkEditingContext = createContext<boolean | null>(null);

type ActiveStroke = {
  pointerId: number;
  target: HTMLElement;
  rect: DOMRect;
  erase: boolean;
  original: InkStroke[];
  strokes: InkStroke[];
  stroke: InkStroke;
  last: InkPoint;
  budget: number;
};

type CanvasProps = {
  drawing: InkDrawing;
  tool: "pen" | "eraser";
  color: string;
  width: number;
  mouse: boolean;
  editable?: boolean;
  canEdit: () => boolean;
  remainingPoints: () => number;
  onCommit: (strokes: InkStroke[]) => boolean;
  registerFinish: (finish: () => void) => () => void;
  // Note ink listens above the textbox so mouse selection and finger scrolling
  // still reach the editor. The transparent canvas itself never takes input.
  surface?: RefObject<HTMLDivElement | null>;
};

export function InkCanvas(props: CanvasProps) {
  const editable = props.editable ?? props.canEdit();
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef<ActiveStroke | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // React node views may deliver attributes after the next pointer gesture starts.
  // Retain the last successful commit immediately so a fast second stroke appends.
  const committed = useRef(props.drawing);
  const incoming = useRef(props.drawing);
  if (incoming.current !== props.drawing) { incoming.current = props.drawing; committed.current = props.drawing; }
  const paint = useRef<() => void>(() => undefined);
  const base = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef<number | null>(null);
  const [message, setMessage] = useState("");
  const hintId = useId();

  const schedulePaint = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; paint.current(); });
  };

  const rebuildBase = useCallback(() => {
    const element = canvas.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(8_000_000 / (rect.width * rect.height)));
    element.width = Math.round(rect.width * ratio);
    element.height = Math.round(rect.height * ratio);
    const buffer = base.current ??= document.createElement("canvas");
    buffer.width = element.width; buffer.height = element.height;
    const context = buffer.getContext("2d");
    if (!context) return;
    const drawing = committed.current;
    context.setTransform(buffer.width / (latest.current.surface ? rect.width : drawing.width), 0, 0, buffer.height / (latest.current.surface ? rect.height : drawing.height), 0, 0);
    drawing.strokes.forEach(stroke => paintStroke(context, stroke, drawing.width, drawing.height));
    paint.current();
  }, []);

  paint.current = () => {
    const element = canvas.current, buffer = base.current;
    const context = element?.getContext("2d");
    if (!element || !context || !buffer) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, element.width, element.height);
    const drawing = committed.current, gesture = active.current;
    if (!gesture?.erase) context.drawImage(buffer, 0, 0);
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    context.setTransform(element.width / (latest.current.surface ? rect.width : drawing.width), 0, 0, element.height / (latest.current.surface ? rect.height : drawing.height), 0, 0);
    if (gesture?.erase) gesture.strokes.forEach(stroke => paintStroke(context, stroke, drawing.width, drawing.height));
    else if (gesture) paintStroke(context, gesture.stroke, drawing.width, drawing.height);
    element.dataset.empty = String(!(gesture ? gesture.strokes.length + (gesture.erase ? 0 : 1) : drawing.strokes.length));
  };

  const finish = useCallback(() => {
    const gesture = active.current;
    if (!gesture) return;
    active.current = null;
    const next = gesture.erase ? gesture.strokes : [...gesture.strokes, gesture.stroke];
    if (!gesture.erase || next.length !== gesture.original.length) {
      if (latest.current.onCommit(next)) committed.current = { ...committed.current, strokes: next };
      else setMessage(latest.current.surface ? "This note has reached its drawing limit. Start a new note to keep drawing." : "This drawing is full. Add another ink drawing to continue.");
    }
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    rebuildBase();
    schedulePaint();
  }, [rebuildBase]);

  useEffect(() => props.registerFinish(finish), [props.registerFinish, finish]);
  useLayoutEffect(rebuildBase, [props.drawing, rebuildBase]);
  useEffect(() => {
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => { finish(); rebuildBase(); }) : null;
    if (resize && canvas.current) resize.observe(canvas.current);
    const onBlur = () => finish();
    const onResize = () => { finish(); rebuildBase(); };
    const onHidden = () => { if (document.hidden) finish(); };
    window.addEventListener("resize", onResize);
    if (props.surface) window.addEventListener("scroll", onBlur, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onBlur, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [rebuildBase, finish, props.surface]);

  const sample = (event: PointerEvent, includeRelease = false) => {
    const gesture = active.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const drawing = committed.current;
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const item of [...samples, event]) {
      const point = inkPoint(item, gesture.rect);
      // Pointer-up pressure is zero; retain the last contact pressure.
      if (includeRelease && !item.pressure) point.pressure = gesture.last.pressure;
      if (gesture.erase) {
        const radius = latest.current.surface ? 10 : 10 * drawing.width / gesture.rect.width;
        gesture.strokes = gesture.strokes.filter(stroke => !strokeHitsEraser(stroke, gesture.last, point, drawing.width, drawing.height, radius));
      } else if (Math.hypot((point.x - gesture.last.x) * drawing.width, (point.y - gesture.last.y) * drawing.height) >= 0.5) {
        if (gesture.stroke.points.length >= gesture.budget) {
          setMessage(latest.current.surface ? "Stroke limit reached. Lift your pen to continue." : "Stroke limit reached. Lift your pen to continue, or add another ink drawing.");
          finish();
          return;
        }
        gesture.stroke.points.push(point);
      }
      if (gesture.erase || gesture.stroke.points[gesture.stroke.points.length - 1] === point) gesture.last = point;
    }
    schedulePaint();
  };

  const start = (event: PointerEvent, target: HTMLElement) => {
    const current = latest.current;
    if (!current.canEdit() || active.current || event.pointerType === "touch"
      || (event.pointerType !== "pen" && !(current.mouse && event.pointerType === "mouse"))
      || (event.button !== 0 && !(event.pointerType === "pen" && event.button === 5))) return;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return;
    if (!rect.width || !rect.height) return;
    const erase = current.tool === "eraser" || (event.buttons & 32) !== 0 || event.button === 5;
    const drawing = committed.current;
    if (current.surface && (event.clientX - rect.left > drawing.width || event.clientY - rect.top > drawing.height)) {
      setMessage("This part of the note is beyond the drawing area. Start a new note to keep drawing.");
      return;
    }
    const budget = Math.min(MAX_STROKE_POINTS, MAX_DRAWING_POINTS - pointCount(drawing.strokes), current.remainingPoints());
    if (!erase && (budget < 1 || drawing.strokes.length >= MAX_INK_STROKES)) {
      setMessage(current.surface ? "This note has reached its drawing limit. Erase some ink or start a new note." : "This drawing is full. Add another ink drawing to continue.");
      return;
    }
    event.preventDefault(); event.stopPropagation();
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    const coordinates = current.surface ? new DOMRect(rect.left, rect.top, drawing.width, drawing.height) : rect;
    const point = inkPoint(event, coordinates);
    active.current = {
      pointerId: event.pointerId, target, rect: coordinates, erase, original: drawing.strokes, strokes: drawing.strokes,
      stroke: { color: current.color, width: current.width, points: [point] }, last: point, budget,
    };
    setMessage("");
    sample(event);
  };

  useEffect(() => {
    const target = props.surface?.current;
    if (!target) return;
    let suppressClick = false;
    const over = (event: PointerEvent) => {
      // pointerover precedes pointerdown, including on digitizers without hover.
      // Set this synchronously, before the browser chooses a pan gesture.
      if (!active.current) target.style.touchAction = latest.current.canEdit() && (event.pointerType === "pen" || (event.pointerType === "mouse" && latest.current.mouse)) ? "none" : "pan-y";
    };
    const down = (event: PointerEvent) => {
      if ((event.target as Element).closest(".ink-node")) return;
      if (active.current) { if (event.pointerType === "touch") { event.preventDefault(); event.stopPropagation(); } return; }
      suppressClick = false;
      start(event, target);
      suppressClick = active.current !== null;
    };
    const move = (event: PointerEvent) => {
      if (active.current?.pointerId === event.pointerId) { event.preventDefault(); event.stopPropagation(); sample(event); }
    };
    const up = (event: PointerEvent) => {
      if (active.current?.pointerId === event.pointerId) { event.preventDefault(); event.stopPropagation(); sample(event, true); finish(); }
    };
    const interrupted = (event: PointerEvent) => { if (active.current?.pointerId === event.pointerId) finish(); };
    const click = (event: MouseEvent) => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } };
    target.addEventListener("pointerover", over, true);
    target.addEventListener("pointerdown", down, true);
    target.addEventListener("pointermove", move, true);
    target.addEventListener("pointerup", up, true);
    target.addEventListener("pointercancel", interrupted, true);
    target.addEventListener("lostpointercapture", interrupted, true);
    target.addEventListener("click", click, true);
    return () => {
      target.removeEventListener("pointerover", over, true);
      target.removeEventListener("pointerdown", down, true);
      target.removeEventListener("pointermove", move, true);
      target.removeEventListener("pointerup", up, true);
      target.removeEventListener("pointercancel", interrupted, true);
      target.removeEventListener("lostpointercapture", interrupted, true);
      target.removeEventListener("click", click, true);
    };
  }, [props.surface, finish]);

  if (props.surface) return <>
    <div className="note-ink-layer" style={{ maxWidth: props.drawing.width, maxHeight: props.drawing.height }} aria-hidden={!props.drawing.strokes.length}>
      <canvas ref={canvas} className="ink-canvas note-ink-canvas" role="img" aria-label={props.drawing.description || "Handwriting on note"} data-empty={!props.drawing.strokes.length} />
    </div>
    <p className="note-ink-message" role="status">{message}</p>
  </>;

  return <>
    <div className={`ink-paper${props.tool === "eraser" ? " is-erasing" : ""}`} style={{ aspectRatio: `${props.drawing.width} / ${props.drawing.height}` }}>
      <canvas ref={canvas} className="ink-canvas" role="img" tabIndex={editable ? 0 : undefined}
        aria-label={props.drawing.description || "Ink drawing"} aria-describedby={editable ? hintId : undefined}
        data-empty={props.drawing.strokes.length === 0} onPointerDown={event => start(event.nativeEvent, event.currentTarget)}
        onPointerMove={event => { if (active.current?.pointerId === event.pointerId) { event.preventDefault(); sample(event.nativeEvent); } }}
        onPointerUp={event => { if (active.current?.pointerId === event.pointerId) { sample(event.nativeEvent, true); finish(); } }}
        onPointerCancel={event => { if (active.current?.pointerId === event.pointerId) finish(); }}
        onLostPointerCapture={event => { if (active.current?.pointerId === event.pointerId) finish(); }}
        onBlur={finish} onContextMenu={event => event.preventDefault()} />
      <span className="ink-empty" aria-hidden="true">{editable ? "A little space to draw" : "Empty ink drawing"}</span>
    </div>
    {editable && <p id={hintId} className="ink-hint">{props.mouse ? "Draw with your pen or mouse." : "Write with your pen, or enable mouse drawing."} Eraser removes whole strokes.</p>}
    <p className="ink-message" role="status">{message}</p>
  </>;
}

function InkNodeView({ node, editor, getPos, deleteNode }: NodeViewProps) {
  const editing = useContext(InkEditingContext) ?? editor.isEditable;
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState(inkColors[0].value);
  const [width, setWidth] = useState(4);
  const [mouse, setMouse] = useState(false);
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({ undo: current.can().undo(), redo: current.can().redo() }) });
  const drawing = useMemo(() => isInkDrawing(node.attrs) ? node.attrs : null, [node.attrs]);
  const canEdit = useCallback(() => editing && editor.isEditable, [editor, editing]);
  const remainingPoints = useCallback(() => {
    return MAX_DOCUMENT_INK_POINTS - documentInkUsage(editor.state.doc).points;
  }, [editor]);
  const registerFinish = useCallback((finish: () => void) => registerInkSession(editor, finish), [editor]);
  const commit = useCallback((patch: Partial<InkDrawing>) => {
    if (!editor.isEditable || editor.isDestroyed) return false;
    const position = getPos();
    const current = typeof position === "number" ? editor.state.doc.nodeAt(position) : null;
    if (!current || current.type.name !== "ink" || typeof position !== "number") return false;
    const next = { ...current.attrs, ...patch };
    if (!isInkDrawing(next)) return false;
    if (patch.strokes && pointCount(patch.strokes) - pointCount(current.attrs.strokes) > remainingPoints()) return false;
    editor.view.dispatch(closeHistory(editor.state.tr.setNodeMarkup(position, undefined, next)));
    editor.view.dispatch(closeHistory(editor.state.tr));
    return true;
  }, [editor, getPos, remainingPoints]);
  const onCommit = useCallback((strokes: InkStroke[]) => commit({ strokes }), [commit]);
  const action = (run: () => void) => { if (canEdit()) { finishActiveInk(editor); run(); } };

  if (!drawing) return <NodeViewWrapper contentEditable={false} className="ink-node"><p role="alert">This ink drawing could not be displayed.</p></NodeViewWrapper>;
  return <NodeViewWrapper className="ink-node" contentEditable={false} data-cozynotes-ink="true" onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()} onKeyDown={(event: ReactKeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault(); event.stopPropagation(); action(() => { if (event.shiftKey) editor.commands.redo(); else editor.commands.undo(); });
    }
  }}>
    <div className="ink-heading"><span>Ink drawing</span>{editing && <button type="button" className="tool" aria-label="Delete ink drawing" title="Delete ink drawing" onClick={() => action(() => { deleteNode(); editor.commands.focus(); })}><Trash2 size={15} /></button>}</div>
    {editing && <div className="ink-controls" role="group" aria-label="Drawing tools">
      <button type="button" className={`tool${tool === "pen" ? " active" : ""}`} aria-label="Pen" title="Pen" aria-pressed={tool === "pen"} onClick={() => action(() => setTool("pen"))}><PenLine size={16} /></button>
      <button type="button" className={`tool${tool === "eraser" ? " active" : ""}`} aria-label="Stroke eraser" title="Stroke eraser" aria-pressed={tool === "eraser"} onClick={() => action(() => setTool("eraser"))}><Eraser size={16} /></button>
      <label className="ink-setting">Color<select value={color} onChange={event => action(() => setColor(event.target.value))}>{inkColors.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}</select></label>
      <label className="ink-setting">Width<select value={width} onChange={event => action(() => setWidth(Number(event.target.value)))}><option value={2}>Fine</option><option value={4}>Medium</option><option value={8}>Thick</option></select></label>
      <button type="button" className="tool" aria-label="Undo" title="Undo" disabled={!state.undo} onClick={() => action(() => { editor.commands.undo(); })}><Undo2 size={16} /></button>
      <button type="button" className="tool" aria-label="Redo" title="Redo" disabled={!state.redo} onClick={() => action(() => { editor.commands.redo(); })}><Redo2 size={16} /></button>
      <label className="ink-mouse"><input type="checkbox" checked={mouse} onChange={event => action(() => setMouse(event.target.checked))} /> Draw with mouse</label>
    </div>}
    <InkCanvas drawing={drawing} tool={tool} color={color} width={width} mouse={mouse} editable={editing} canEdit={canEdit} remainingPoints={remainingPoints} onCommit={onCommit} registerFinish={registerFinish} />
    {editing ? <label className="ink-description">Drawing description<input value={drawing.description} maxLength={240} placeholder="Optional: describe your drawing" onChange={event => { if (canEdit()) commit({ description: event.target.value }); }} /></label>
      : drawing.description && <p className="ink-caption">{drawing.description}</p>}
  </NodeViewWrapper>;
}

export const CozyInk = Node.create({
  name: "ink", group: "block", atom: true, selectable: true, isolating: true,
  addAttributes() {
    return Object.fromEntries(Object.entries(emptyInk()).map(([key, value]) => [key, { default: value, rendered: false }]));
  },
  parseHTML() {
    return [{ tag: "div[data-cozynotes-ink]", getAttrs: element => {
      const raw = element.getAttribute("data-ink");
      if (!raw || raw.length > 8_000_000) return false;
      try { const value: unknown = JSON.parse(raw); return isInkDrawing(value) ? value : false; }
      catch { return false; }
    } }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-cozynotes-ink": "true", "data-ink": JSON.stringify(node.attrs) }), node.attrs.description || "[Ink]"];
  },
  renderText({ node }) { return node.attrs.description ? `[Ink: ${node.attrs.description}]` : "[Ink]"; },
  addNodeView() { return ReactNodeViewRenderer(InkNodeView); },
});

export function insertInkDrawing(editor: NodeViewProps["editor"]) {
  if (!editor.isEditable) return false;
  finishActiveInk(editor);
  if (documentInkUsage(editor.state.doc).drawings >= MAX_INK_DRAWINGS) return false;
  const inserted = editor.chain().focus().insertContent([{ type: "ink", attrs: emptyInk() }, { type: "paragraph" }]).run();
  if (inserted) requestAnimationFrame(() => {
    if (editor.isDestroyed) return;
    let position: number | null = null;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "ink" && pos < editor.state.selection.from) position = pos; });
    if (position !== null) (editor.view.nodeDOM(position) as HTMLElement | null)?.querySelector<HTMLCanvasElement>("canvas")?.focus();
  });
  return inserted;
}
