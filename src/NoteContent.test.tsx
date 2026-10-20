// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CozyInk } from "./InkNode";
import { emptyInk } from "./ink";
import type { InkDrawing } from "./ink";
import { finishActiveInk } from "./inkSession";
import { defaultNoteInkTools, NoteContent, NoteDrawingTools } from "./NoteContent";
import { commitNoteInk, CozyDocument, documentInkUsage, emptyNoteInk, getNoteDocument, loadNoteDocument, noteInkBounds } from "./noteInk";

const editors: Editor[] = [];
const pointer = { pointerId: 1, pointerType: "pen", clientX: 40, clientY: 60, pressure: 0.7, tiltX: -20, tiltY: 30, button: 0, buttons: 1 };
let rect: DOMRect;
const context = { setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };

class TestPointerEvent extends MouseEvent {
  pointerId: number; pointerType: string; pressure: number; tiltX: number; tiltY: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "pen";
    this.pressure = init.pressure ?? 0.5; this.tiltX = init.tiltX ?? 0; this.tiltY = init.tiltY ?? 0;
  }
}

beforeEach(() => {
  rect = new DOMRect(10, 20, 300, 220);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => rect);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); editors.splice(0).forEach(editor => editor.destroy()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function note(drawing: InkDrawing | null = null, editable = true) {
  const update = vi.fn();
  const editor = new Editor({
    extensions: [StarterKit.configure({ document: false }), CozyDocument, CozyInk],
    content: { type: "doc", attrs: { ink: drawing }, content: [{ type: "paragraph", content: [{ type: "text", text: "Typed text" }] }] },
    editable, onUpdate: update,
    editorProps: { attributes: { role: "textbox", "aria-label": "Note text" } },
  });
  editors.push(editor);
  const view = render(<NoteContent editor={editor} editable={editable} />);
  return { editor, update, textbox: screen.getByRole("textbox", { name: "Note text" }), ...view };
}

function draw(target: HTMLElement, id = 1, pointerType = "pen") {
  fireEvent.pointerOver(target, { ...pointer, pointerId: id, pointerType });
  fireEvent.pointerDown(target, { ...pointer, pointerId: id, pointerType });
  fireEvent.pointerMove(target, { ...pointer, pointerId: id, pointerType, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(target, { ...pointer, pointerId: id, pointerType, clientX: 130, clientY: 120, pressure: 0 });
}

describe("drawing on the note textbox", () => {
  it("loads root-level ink along with text, without creating an undo step or dirty save", () => {
    const { editor, textbox, update } = note(null, false);
    const ink = { ...emptyNoteInk(), description: "Saved handwriting", strokes: [{ color: "#315e9e", width: 4, points: [{ x: 0.02, y: 0.03, pressure: 0.5, tiltX: 0, tiltY: 0 }] }] };
    const document = { type: "doc", attrs: { ink }, content: [{ type: "paragraph", content: [{ type: "text", text: "Saved text" }] }] };
    act(() => loadNoteDocument(editor, document));
    expect(editor.getJSON()).toEqual(document);
    expect(textbox.textContent).toBe("Saved text");
    expect(screen.getByRole("img", { name: "Saved handwriting" })).toBeTruthy();
    expect(editor.can().undo()).toBe(false);
    expect(update).not.toHaveBeenCalled();
    act(() => loadNoteDocument(editor, { type: "doc", content: [{ type: "paragraph" }] }));
    expect(editor.state.doc.attrs.ink).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the older text-only format until the note actually has ink", () => {
    const { editor, textbox } = note();
    expect(getNoteDocument(editor).attrs).toBeUndefined();
    draw(textbox);
    expect(getNoteDocument(editor).attrs?.ink.strokes).toHaveLength(1);
    act(() => { commitNoteInk(editor, null); });
    expect(getNoteDocument(editor).attrs).toBeUndefined();
    expect(editor.state.doc.attrs.ink).toBeNull();
  });

  it("accepts pen input immediately, preserves typed text, and never inserts an ink attachment", () => {
    const { editor, textbox, update } = note();
    draw(textbox);
    expect(editor.getText()).toBe("Typed text");
    expect(editor.getJSON().content?.map(node => node.type)).toEqual(["paragraph"]);
    const ink = editor.state.doc.attrs.ink as InkDrawing;
    expect(ink.strokes).toHaveLength(1);
    expect(ink.strokes[0].points[0]).toMatchObject({ pressure: 0.7, tiltX: -20, tiltY: 30 });
    expect(ink.strokes[0].points[0].x * ink.width).toBeCloseTo(30, 1);
    expect(update).toHaveBeenCalledOnce();
    expect(screen.getByRole("img", { name: "Handwriting on note" })).toBeTruthy();
  });

  it("lets mouse and touch reach the textbox by default, and enables mouse drawing explicitly", () => {
    const { editor, textbox, rerender } = note();
    for (const pointerType of ["mouse", "touch"]) {
      fireEvent.pointerOver(textbox, { ...pointer, pointerType });
      expect(fireEvent.pointerDown(textbox, { ...pointer, pointerType })).toBe(true);
      fireEvent.pointerUp(textbox, { ...pointer, pointerType });
    }
    expect(textbox.closest<HTMLElement>(".note-content")?.style.touchAction).toBe("pan-y");
    expect(editor.state.doc.attrs.ink).toBeNull();
    rerender(<NoteContent editor={editor} editable tools={{ ...defaultNoteInkTools, mouse: true }} />);
    draw(textbox, 2, "mouse");
    expect(editor.state.doc.attrs.ink.strokes[0].points[0].pressure).toBe(0.5);
  });

  it("creates separate undo steps for typing and each stroke, including shortcuts after pen focus", () => {
    const { editor, textbox } = note();
    act(() => { editor.commands.insertContent("More "); });
    draw(textbox);
    draw(textbox, 2);
    const surface = textbox.closest<HTMLElement>(".note-content")!;
    fireEvent.keyDown(surface, { key: "z", ctrlKey: true });
    expect(editor.state.doc.attrs.ink.strokes).toHaveLength(1);
    fireEvent.keyDown(surface, { key: "z", ctrlKey: true });
    expect(editor.state.doc.attrs.ink).toBeNull();
    expect(editor.getText()).toBe("More Typed text");
    fireEvent.keyDown(surface, { key: "z", ctrlKey: true });
    expect(editor.getText()).toBe("Typed text");
    fireEvent.keyDown(surface, { key: "y", ctrlKey: true });
    fireEvent.keyDown(surface, { key: "z", ctrlKey: true, shiftKey: true });
    expect(editor.state.doc.attrs.ink.strokes).toHaveLength(1);
  });

  it("commits a wet stroke before the existing save barrier locks the note", () => {
    const { editor, textbox, update } = note();
    fireEvent.pointerDown(textbox, pointer);
    fireEvent.pointerMove(textbox, { ...pointer, clientX: 100 });
    expect(update).not.toHaveBeenCalled();
    act(() => { finishActiveInk(editor); editor.setEditable(false, false); });
    expect(editor.state.doc.attrs.ink.strokes[0].points).toHaveLength(2);
    draw(textbox, 2);
    expect(update).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "lostpointercapture", "blur", "scroll", "resize"])("retains interrupted note ink exactly once on %s", reason => {
    const { editor, textbox, update } = note();
    fireEvent.pointerDown(textbox, pointer);
    fireEvent.pointerMove(textbox, { ...pointer, clientX: 100 });
    if (["blur", "scroll", "resize"].includes(reason)) fireEvent(window, new Event(reason));
    else fireEvent(textbox, new TestPointerEvent(reason, { ...pointer, bubbles: true }));
    fireEvent.pointerUp(textbox, pointer);
    expect(editor.state.doc.attrs.ink.strokes[0].points).toHaveLength(2);
    expect(update).toHaveBeenCalledOnce();
  });

  it("keeps existing strokes at the same paper coordinates after resize and when drawing further down a scrolled note", () => {
    const { editor, textbox } = note();
    draw(textbox);
    const original = editor.getJSON();
    rect = new DOMRect(10, -180, 500, 600);
    fireEvent(window, new Event("resize"));
    expect(editor.getJSON()).toEqual(original);
    draw(textbox, 2);
    const ink = editor.state.doc.attrs.ink as InkDrawing;
    expect(ink.strokes[0]).toEqual(original.attrs?.ink.strokes[0]);
    expect(ink.strokes[1].points[0].y * ink.height).toBeCloseTo(240, 1);
    expect(noteInkBounds(ink).height).toBeGreaterThan(300);
  });

  it("erases note strokes with the hardware eraser and restores them with Undo", () => {
    const { editor, textbox } = note();
    draw(textbox);
    const saved = editor.getJSON();
    fireEvent.pointerDown(textbox, { ...pointer, button: 5, buttons: 32 });
    fireEvent.pointerUp(textbox, { ...pointer, button: 5, buttons: 0 });
    expect(editor.state.doc.attrs.ink).toBeNull();
    act(() => { editor.commands.undo(); });
    expect(editor.getJSON()).toEqual(saved);
  });

  it("ignores a palm during a pen gesture and prevents the resulting click from activating editor controls", () => {
    const { editor, textbox } = note();
    fireEvent.pointerOver(textbox, pointer);
    fireEvent.pointerDown(textbox, pointer);
    expect(fireEvent.pointerDown(textbox, { ...pointer, pointerId: 2, pointerType: "touch" })).toBe(false);
    fireEvent.pointerUp(textbox, { ...pointer, pointerId: 2, pointerType: "touch" });
    fireEvent.pointerUp(textbox, pointer);
    expect(fireEvent.click(textbox)).toBe(false);
    expect(editor.state.doc.attrs.ink.strokes).toHaveLength(1);
    expect(fireEvent.pointerDown(textbox, { ...pointer, pointerType: "mouse" })).toBe(true);
    expect(fireEvent.click(textbox)).toBe(true);
  });

  it("renders saved note ink read-only with its description", () => {
    const ink = emptyNoteInk();
    ink.description = "A blue flower";
    ink.strokes = [{ color: "#315e9e", width: 4, points: [{ x: 0.02, y: 0.02, pressure: 0.5, tiltX: 0, tiltY: 0 }] }];
    const { editor, textbox, update } = note(ink, false);
    draw(textbox);
    expect(screen.getByRole("img", { name: "A blue flower" })).toBeTruthy();
    expect(editor.state.doc.attrs.ink).toEqual(ink);
    expect(update).not.toHaveBeenCalled();
    expect(editor.can().undo()).toBe(false);
  });

  it("keeps legacy inline drawings editable without also drawing on the note layer", async () => {
    const { editor } = note();
    act(() => { editor.commands.insertContent({ type: "ink", attrs: emptyInk() }); });
    draw(await screen.findByRole("img", { name: "Ink drawing" }));
    expect(editor.state.doc.attrs.ink).toBeNull();
    expect(editor.getJSON().content?.find(node => node.type === "ink")?.attrs?.strokes).toHaveLength(1);
    expect(documentInkUsage(editor.state.doc).points).toBeGreaterThan(0);
  });

  it("clears ink with an undoable tool action and retains the note text", () => {
    const { editor, textbox } = note();
    draw(textbox);
    render(<NoteDrawingTools editor={editor} disabled={false} tools={defaultNoteInkTools} onChange={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Drawing description"), { target: { value: "A flower" } });
    expect(editor.state.doc.attrs.ink.description).toBe("A flower");
    fireEvent.click(screen.getByRole("button", { name: "Clear note ink" }));
    expect(editor.state.doc.attrs.ink).toBeNull();
    expect(editor.getText()).toBe("Typed text");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor.state.doc.attrs.ink.description).toBe("A flower");
  });

  it("shares drawing and point budgets with legacy ink instead of bypassing note limits", () => {
    const { editor } = note();
    const ink = emptyNoteInk();
    ink.strokes = [{ color: "#315e9e", width: 4, points: [{ x: 0.02, y: 0.02, pressure: 0.5, tiltX: 0, tiltY: 0 }] }];
    act(() => { editor.commands.setContent({ type: "doc", content: Array.from({ length: 64 }, () => ({ type: "ink", attrs: emptyInk() })) }); });
    expect(commitNoteInk(editor, ink)).toBe(false);
    expect(editor.state.doc.attrs.ink).toBeNull();
  });
});
