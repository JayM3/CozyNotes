// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { CozyInk, InkCanvas, InkEditingContext } from "./InkNode";
import { emptyInk } from "./ink";
import type { InkStroke } from "./ink";
import { finishActiveInk } from "./inkSession";

const editors: Editor[] = [];
const pointer = { pointerId: 1, pointerType: "pen", clientX: 40, clientY: 60, pressure: 0.6, tiltX: -25, tiltY: 30, button: 0, buttons: 1 };
const line: InkStroke = { color: "#332f2a", width: 4, points: [
  { x: 0.1, y: 0.5, pressure: 0.6, tiltX: -25, tiltY: 30 },
  { x: 0.9, y: 0.5, pressure: 0.8, tiltX: 0, tiltY: 0 },
] };

class TestPointerEvent extends MouseEvent {
  pointerId: number; pointerType: string; pressure: number; tiltX: number; tiltY: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "pen";
    this.pressure = init.pressure ?? 0.5; this.tiltX = init.tiltX ?? 0; this.tiltY = init.tiltY ?? 0;
  }
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 300, 200));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLCanvasElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(true);
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); editors.splice(0).forEach(editor => editor.destroy()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function surface(options: Partial<Parameters<typeof InkCanvas>[0]> = {}) {
  const commit = vi.fn().mockReturnValue(true);
  let finish = () => {};
  const view = render(<InkCanvas drawing={emptyInk()} tool="pen" color="#332f2a" width={4} mouse={false} canEdit={() => true} remainingPoints={() => 100_000}
    onCommit={commit} registerFinish={value => { finish = value; return () => {}; }} {...options} />);
  return { canvas: screen.getByRole("img"), commit, finish: () => finish(), ...view };
}

function draw(canvas: HTMLElement, id = 1) {
  fireEvent.pointerDown(canvas, { ...pointer, pointerId: id });
  fireEvent.pointerMove(canvas, { ...pointer, pointerId: id, clientX: 100, clientY: 100, pressure: 0.9 });
  fireEvent.pointerUp(canvas, { ...pointer, pointerId: id, clientX: 130, clientY: 120, pressure: 0 });
}

describe("ink input", () => {
  it("keeps wet ink local, commits once on pen up, and retains pressure/tilt and the final endpoint", () => {
    const { canvas, commit } = surface();
    fireEvent.pointerDown(canvas, pointer);
    fireEvent.pointerMove(canvas, { ...pointer, clientX: 100, pressure: 0.9 });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.pointerUp(canvas, { ...pointer, clientX: 130, pressure: 0 });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0][0].points).toEqual([
      { x: 0.1, y: 0.2, pressure: 0.6, tiltX: -25, tiltY: 30 },
      { x: 0.3, y: 0.2, pressure: 0.9, tiltX: -25, tiltY: 30 },
      { x: 0.4, y: 0.2, pressure: 0.9, tiltX: -25, tiltY: 30 },
    ]);
  });

  it("uses coalesced pen samples and ignores movement from a second pointer", () => {
    const { canvas, commit } = surface();
    fireEvent.pointerDown(canvas, pointer);
    const event = new TestPointerEvent("pointermove", { ...pointer, clientX: 130, bubbles: true });
    Object.assign(event, { getCoalescedEvents: () => [new TestPointerEvent("pointermove", { ...pointer, clientX: 80 })] });
    fireEvent(canvas, event);
    fireEvent.pointerMove(canvas, { ...pointer, pointerId: 2, clientX: 250 });
    fireEvent.pointerUp(canvas, { ...pointer, clientX: 130 });
    expect(commit.mock.calls[0][0][0].points.map((point: { x: number }) => point.x)).toEqual([0.1, 0.23333, 0.4]);
  });

  it("ignores touch and mouse by default, and supports an explicit mouse mode", () => {
    const { canvas, commit, rerender } = surface();
    for (const pointerType of ["touch", "mouse"]) {
      fireEvent.pointerDown(canvas, { ...pointer, pointerType });
      fireEvent.pointerUp(canvas, { ...pointer, pointerType });
    }
    expect(commit).not.toHaveBeenCalled();
    rerender(<InkCanvas drawing={emptyInk()} tool="pen" color="#332f2a" width={4} mouse canEdit={() => true} remainingPoints={() => 100}
      onCommit={commit} registerFinish={() => () => {}} />);
    fireEvent.pointerDown(canvas, { ...pointer, pointerType: "mouse" });
    fireEvent.pointerUp(canvas, { ...pointer, pointerType: "mouse" });
    expect(commit.mock.calls[0][0][0].points[0].pressure).toBe(0.5);
  });

  it.each(["pointercancel", "lostpointercapture", "blur", "save"])("preserves a partial stroke exactly once on %s", reason => {
    const { canvas, commit, finish } = surface();
    fireEvent.pointerDown(canvas, pointer);
    fireEvent.pointerMove(canvas, { ...pointer, clientX: 100 });
    if (reason === "save") act(finish);
    else if (reason === "blur") fireEvent(window, new Event("blur"));
    else fireEvent(canvas, new TestPointerEvent(reason, { ...pointer, bubbles: true }));
    fireEvent.pointerUp(canvas, pointer);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0][0].points).toHaveLength(2);
  });

  it("handles the hardware eraser and sweeps entire strokes between input samples", () => {
    const { canvas, commit } = surface({ drawing: { ...emptyInk(), strokes: [line] } });
    fireEvent.pointerDown(canvas, { ...pointer, clientX: 160, clientY: 30, button: 5, buttons: 32 });
    fireEvent.pointerMove(canvas, { ...pointer, clientX: 160, clientY: 210, buttons: 32 });
    fireEvent.pointerUp(canvas, { ...pointer, clientX: 160, clientY: 210, button: 5, buttons: 0 });
    expect(commit).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("keeps captured coordinates bounded and stops when the remaining point budget is used", () => {
    const { canvas, commit } = surface({ remainingPoints: () => 2 });
    fireEvent.pointerDown(canvas, pointer);
    fireEvent.pointerMove(canvas, { ...pointer, clientX: 999, clientY: -20 });
    fireEvent.pointerMove(canvas, { ...pointer, clientX: 80, clientY: 90 });
    expect(commit.mock.calls[0][0][0].points).toHaveLength(2);
    expect(commit.mock.calls[0][0][0].points[1]).toMatchObject({ x: 1, y: 0 });
    expect(screen.getByRole("status").textContent).toContain("Stroke limit");
  });

  it("blocks all mutation in a read-only preview", () => {
    const { canvas, commit } = surface({ canEdit: () => false, drawing: { ...emptyInk(), strokes: [line] } });
    draw(canvas);
    expect(commit).not.toHaveBeenCalled();
    expect(canvas.hasAttribute("tabindex")).toBe(false);
  });
});

describe("ink in the note editor", () => {
  async function note() {
    const update = vi.fn();
    const editor = new Editor({ extensions: [StarterKit, CozyInk], content: { type: "doc", content: [{ type: "ink", attrs: emptyInk() }, { type: "paragraph" }] }, onUpdate: update });
    editors.push(editor);
    render(<EditorContent editor={editor} />);
    const canvas = await screen.findByRole("img", { name: "Ink drawing" });
    return { editor, canvas, update };
  }

  it("creates one independent undo step per stroke and round-trips vector data through HTML", async () => {
    const { editor, canvas, update } = await note();
    draw(canvas);
    draw(canvas, 2);
    await waitFor(() => expect(editor.getJSON().content?.[0].attrs?.strokes).toHaveLength(2));
    expect(update).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor.getJSON().content?.[0].attrs?.strokes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(editor.getJSON().content?.[0].attrs?.strokes).toHaveLength(2);
    const html = editor.getHTML();
    const copy = new Editor({ extensions: [StarterKit, CozyInk], content: html });
    editors.push(copy);
    expect(copy.getJSON()).toEqual(editor.getJSON());
  });

  it("flushes active ink into the same document used by the close/save barrier", async () => {
    const { editor, canvas, update } = await note();
    fireEvent.pointerDown(canvas, pointer);
    fireEvent.pointerMove(canvas, { ...pointer, clientX: 120 });
    expect(update).not.toHaveBeenCalled();
    act(() => { finishActiveInk(editor); editor.setEditable(false, false); });
    expect(editor.getJSON().content?.[0].attrs?.strokes[0].points).toHaveLength(2);
    expect(update).toHaveBeenCalledOnce();
    draw(canvas, 2);
    expect(update).toHaveBeenCalledOnce();
  });

  it("renders stored ink after a note loads while editing was disabled", async () => {
    const editor = new Editor({ extensions: [StarterKit, CozyInk], editable: false, content: { type: "doc", content: [{ type: "paragraph" }] } });
    editors.push(editor);
    const { rerender } = render(<InkEditingContext.Provider value={false}><EditorContent editor={editor} /></InkEditingContext.Provider>);
    act(() => { editor.chain().setContent({ type: "doc", content: [{ type: "ink", attrs: { ...emptyInk(), strokes: [line] } }, { type: "paragraph" }] }, { emitUpdate: false }).setMeta("addToHistory", false).run(); });
    expect(screen.queryByRole("group", { name: "Drawing tools" })).toBeNull();
    act(() => editor.setEditable(true, false));
    rerender(<InkEditingContext.Provider value><EditorContent editor={editor} /></InkEditingContext.Provider>);
    expect(await screen.findByRole("group", { name: "Drawing tools" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ink drawing" }).getAttribute("tabindex")).toBe("0");
    expect(editor.can().undo()).toBe(false);
    fireEvent.change(screen.getByLabelText("Drawing description"), { target: { value: "A flower" } });
    expect(editor.getText()).toContain("[Ink: A flower]");
    fireEvent.click(screen.getByRole("button", { name: "Delete ink drawing" }));
    expect(editor.getJSON().content?.every(node => node.type !== "ink")).toBe(true);
    act(() => { editor.commands.undo(); });
    expect(editor.getJSON().content?.some(node => node.type === "ink")).toBe(true);
  });
});
