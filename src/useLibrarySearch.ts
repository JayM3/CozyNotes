import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { notesApi } from "./api";
import type { NoteSummary, PaperColor, View } from "./api";

const changeEvents = ["note-created", "note-changed", "note-favorite-changed", "note-trashed", "note-restored", "note-purged", "trash-emptied", "notes-batch-changed"];

export function useLibrarySearch(view: View, query: string, color: PaperColor | null) {
  const [result, setResult] = useState<{ key: string; notes: NoteSummary[] }>({ key: "", notes: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const current = useRef({ view, query, color });
  current.current = { view, query, color };
  const request = useRef(0);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    const filter = current.current;
    const token = ++request.current;
    if (mounted.current) setLoading(true);
    const isCurrent = () => mounted.current && token === request.current
      && filter.view === current.current.view && filter.query === current.current.query && filter.color === current.current.color;
    try {
      const result = await notesApi.list(filter.view === "trash", filter.query.trim(), filter.color);
      if (isCurrent()) { setResult({ key: JSON.stringify([filter.view, filter.query, filter.color]), notes: result }); setError(""); }
    } catch {
      if (isCurrent()) setError("Couldn't load notes. Try again.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const disposers: Array<() => void> = [];
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (eventTimer !== undefined) clearTimeout(eventTimer);
      eventTimer = setTimeout(() => { void refresh(); }, 50);
    };
    changeEvents.forEach(event => {
      void listen(event, changed).then(dispose => {
        if (cancelled) dispose();
        else disposers.push(dispose);
      }).catch(() => undefined);
    });
    window.addEventListener("focus", changed);
    return () => {
      cancelled = true;
      mounted.current = false;
      request.current++;
      if (eventTimer !== undefined) clearTimeout(eventTimer);
      disposers.forEach(dispose => dispose());
      window.removeEventListener("focus", changed);
    };
  }, [refresh]);

  useEffect(() => {
    request.current++;
    setLoading(true);
    const timer = setTimeout(() => { void refresh(); }, 150);
    return () => { clearTimeout(timer); request.current++; };
  }, [view, query, color, refresh]);

  const matchesFilter = result.key === JSON.stringify([view, query, color]);
  return { notes: matchesFilter ? result.notes : [], error, loading, refresh };
}
