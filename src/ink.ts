export type InkPoint = { x: number; y: number; pressure: number; tiltX: number; tiltY: number };
export type InkStroke = { color: string; width: number; points: InkPoint[] };
export type InkDrawing = { version: 1; width: number; height: number; description: string; strokes: InkStroke[] };

// Keep these limits in sync with src-tauri/src/ink.rs.
export const MAX_INK_STROKES = 512;
export const MAX_STROKE_POINTS = 8192;
export const MAX_DRAWING_POINTS = 50_000;
export const MAX_DOCUMENT_INK_POINTS = 100_000;
export const MAX_INK_DRAWINGS = 64;
export const emptyInk = (): InkDrawing => ({ version: 1, width: 600, height: 400, description: "", strokes: [] });
export const inkColors = [
  { name: "Graphite", value: "#332f2a" },
  { name: "Blue", value: "#315e9e" },
  { name: "Green", value: "#32634a" },
  { name: "Red", value: "#a43e3e" },
];

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const range = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => name in value);

export function isInkDrawing(value: unknown): value is InkDrawing {
  if (!record(value) || !keys(value, ["version", "width", "height", "description", "strokes"])
    || value.version !== 1 || !range(value.width, 64, 4096) || !range(value.height, 64, 4096)
    || typeof value.description !== "string" || [...value.description].length > 240
    || !Array.isArray(value.strokes) || value.strokes.length > MAX_INK_STROKES) return false;
  let total = 0;
  return value.strokes.every(stroke => {
    if (!record(stroke) || !keys(stroke, ["color", "width", "points"])
      || typeof stroke.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(stroke.color)
      || !range(stroke.width, 0.5, 24) || !Array.isArray(stroke.points)
      || !stroke.points.length || stroke.points.length > MAX_STROKE_POINTS) return false;
    total += stroke.points.length;
    return total <= MAX_DRAWING_POINTS && stroke.points.every(point => record(point)
      && keys(point, ["x", "y", "pressure", "tiltX", "tiltY"])
      && range(point.x, 0, 1) && range(point.y, 0, 1) && range(point.pressure, 0, 1)
      && range(point.tiltX, -90, 90) && range(point.tiltY, -90, 90));
  });
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const round = (value: number) => Math.round(value * 100_000) / 100_000;
export function inkPoint(event: Pick<PointerEvent, "clientX" | "clientY" | "pressure" | "tiltX" | "tiltY" | "pointerType">, rect: Pick<DOMRect, "left" | "top" | "width" | "height">): InkPoint {
  return {
    x: round(clamp((event.clientX - rect.left) / rect.width, 0, 1)),
    y: round(clamp((event.clientY - rect.top) / rect.height, 0, 1)),
    pressure: round(clamp(event.pointerType === "mouse" ? 0.5 : event.pressure, 0, 1)),
    tiltX: clamp(event.tiltX, -90, 90), tiltY: clamp(event.tiltY, -90, 90),
  };
}

export const pointCount = (strokes: InkStroke[]) => strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
export const pressureWidth = (stroke: InkStroke, point: InkPoint) => stroke.width * (0.25 + point.pressure * 0.75);

export function paintStroke(context: CanvasRenderingContext2D, stroke: InkStroke, width: number, height: number) {
  const first = stroke.points[0];
  if (!first) return;
  context.strokeStyle = context.fillStyle = stroke.color;
  context.lineCap = context.lineJoin = "round";
  context.beginPath();
  context.arc(first.x * width, first.y * height, pressureWidth(stroke, first) / 2, 0, Math.PI * 2);
  context.fill();
  for (let index = 1; index < stroke.points.length; index++) {
    const previous = stroke.points[index - 1], point = stroke.points[index];
    context.lineWidth = (pressureWidth(stroke, previous) + pressureWidth(stroke, point)) / 2;
    context.beginPath();
    context.moveTo(previous.x * width, previous.y * height);
    context.lineTo(point.x * width, point.y * height);
    context.stroke();
  }
}

type XY = { x: number; y: number };
function distanceToSegment(point: XY, a: XY, b: XY) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function segmentsDistance(a: XY, b: XY, c: XY, d: XY) {
  const cross = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b));
}

/** Swept eraser hit testing catches crossings between sparse input samples. */
export function strokeHitsEraser(stroke: InkStroke, from: InkPoint, to: InkPoint, width: number, height: number, radius: number) {
  const project = (point: InkPoint): XY => ({ x: point.x * width, y: point.y * height });
  const a = project(from), b = project(to);
  return stroke.points.some((point, index) => segmentsDistance(a, b, project(stroke.points[Math.max(0, index - 1)]), project(point)) <= radius + stroke.width / 2);
}
