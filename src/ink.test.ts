import { describe, expect, it } from "vitest";
import { emptyInk, inkPoint, isInkDrawing, pressureWidth, strokeHitsEraser } from "./ink";
import type { InkPoint, InkStroke } from "./ink";

const point = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5, tiltX: 0, tiltY: 0 });
const line: InkStroke = { color: "#332f2a", width: 4, points: [point(0.1, 0.5), point(0.9, 0.5)] };

describe("ink geometry and document data", () => {
  it("normalizes pen coordinates at any display size and retains pressure and tilt", () => {
    const event = { clientX: 160, clientY: 70, pressure: 0.8, tiltX: -35, tiltY: 40, pointerType: "pen" };
    expect(inkPoint(event, { left: 10, top: 20, width: 300, height: 200 })).toEqual({ x: 0.5, y: 0.25, pressure: 0.8, tiltX: -35, tiltY: 40 });
    expect(inkPoint({ ...event, clientX: -5, clientY: 999, pointerType: "mouse", pressure: 0 }, { left: 10, top: 20, width: 300, height: 200 })).toMatchObject({ x: 0, y: 1, pressure: 0.5 });
    expect(pressureWidth(line, { ...point(0, 0), pressure: 1 })).toBeGreaterThan(pressureWidth(line, { ...point(0, 0), pressure: 0 }));
  });

  it("erases sparse strokes crossed by a fast gesture without removing nearby strokes", () => {
    expect(strokeHitsEraser(line, point(0.5, 0.1), point(0.5, 0.9), 600, 400, 10)).toBe(true);
    expect(strokeHitsEraser(line, point(0, 0), point(1, 0), 600, 400, 10)).toBe(false);
    expect(strokeHitsEraser({ ...line, points: [point(0.5, 0.5)] }, point(0.5, 0.5), point(0.5, 0.5), 600, 400, 10)).toBe(true);
  });

  it("rejects unsupported versions, malformed attributes, invalid numeric values, and injected colors", () => {
    const drawing = { ...emptyInk(), strokes: [line] };
    expect(isInkDrawing(drawing)).toBe(true);
    for (const invalid of [
      { ...drawing, version: 2 }, { ...drawing, height: Infinity }, { ...drawing, unknown: true },
      { ...drawing, description: "a".repeat(241) },
      { ...drawing, strokes: [{ ...line, color: "url(evil)" }] },
      { ...drawing, strokes: [{ ...line, points: [{ ...point(0, 0), pressure: NaN }] }] },
      { ...drawing, strokes: [{ ...line, points: [{ ...point(0, 0), x: -1 }] }] },
    ]) expect(isInkDrawing(invalid)).toBe(false);
  });
});
