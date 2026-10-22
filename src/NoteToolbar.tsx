import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { startWindowDrag } from "./windowDrag";

const minimumHeight = 82;
const defaultHeight = 82;
const previousDefaultHeight = 96;
const maximumHeight = 180;

function readHeight(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    if (value === previousDefaultHeight) return defaultHeight;
    if (Number.isFinite(value) && value >= minimumHeight) return Math.min(value, maximumHeight);
  } catch { /* Resizing still works when local preferences are unavailable. */ }
  return defaultHeight;
}

export function NoteToolbar({ id, children }: { id: string; children: ReactNode }) {
  const storageKey = `cozynotes.toolbar-height.${id}`;
  const [height, setHeight] = useState(() => readHeight(storageKey));
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const limit = Math.max(minimumHeight, Math.min(maximumHeight, viewportHeight - 152));
  const visibleHeight = Math.min(height, limit);
  const resize = (value: number) => setHeight(Math.round(Math.max(minimumHeight, Math.min(limit, value))));

  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(height)); }
    catch { /* The current window can keep its size without persistence. */ }
  }, [storageKey, height]);

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <header className="note-toolbar" style={{ height: visibleHeight }} data-tauri-drag-region onMouseDown={startWindowDrag}>
    {children}
    <div className="toolbar-resizer" role="separator" tabIndex={0} aria-label="Toolbar height" aria-orientation="horizontal"
      aria-valuemin={minimumHeight} aria-valuemax={limit} aria-valuenow={visibleHeight} aria-valuetext={`${visibleHeight} pixels`}
      title="Resize toolbar" onMouseDown={event => event.stopPropagation()}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, y: event.clientY, height: visibleHeight };
      }}
      onPointerMove={event => {
        if (drag.current?.pointerId === event.pointerId) resize(drag.current.height + event.clientY - drag.current.y);
      }}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => resize(defaultHeight)}
      onKeyDown={event => {
        const step = event.shiftKey ? 16 : 4;
        const next = event.key === "ArrowUp" ? visibleHeight - step : event.key === "ArrowDown" ? visibleHeight + step
          : event.key === "Home" ? minimumHeight : event.key === "End" ? limit : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        resize(next);
      }} />
  </header>;
}
