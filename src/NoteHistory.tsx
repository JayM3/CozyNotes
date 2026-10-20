import { useEffect, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { ArrowLeft, History, X } from "lucide-react";
import { CozyImage } from "./ImageNode";
import { CozyInk } from "./InkNode";
import { CozyDocument } from "./noteInk";
import { NoteContent } from "./NoteContent";
import { notesApi } from "./api";
import type { HistoryEntry, HistoryVersion } from "./api";

function HistoryPreview({ version }: { version: HistoryVersion }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ document: false, link: { openOnClick: false } }), CozyDocument, TaskList, TaskItem.configure({ nested: true }), CozyImage, CozyInk],
    content: version.document,
    editable: false,
    editorProps: { attributes: { class: "note-editor", "aria-label": "Saved note content" } },
  }, [version.revision]);
  return <div className={`history-preview paper-${version.color}`}><h3>{version.title}</h3><NoteContent editor={editor} /></div>;
}

export function NoteHistory({ id, onClose, onRestore }: {
  id: string;
  onClose: () => void;
  onRestore: (revision: number) => Promise<void>;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [version, setVersion] = useState<HistoryVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const lastRevision = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void notesApi.history(id).then(result => { if (!cancelled) setEntries(result); })
      .catch(() => { if (!cancelled) setError("Couldn't load note history. Please try again."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; request.current++; };
  }, [id, attempt]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Popover returns focus to its trigger after the action. Focus the dialog
    // on the next frame, after that trigger has finished handling the click.
    const frame = requestAnimationFrame(() => closeButton.current?.focus());
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (busy) dialog.current?.focus();
    else if (version) dialog.current?.querySelector<HTMLButtonElement>(".history-back")?.focus();
    else if (document.activeElement === dialog.current) closeButton.current?.focus();
  }, [busy, version]);

  const showVersion = async (entry: HistoryEntry) => {
    const token = ++request.current;
    lastRevision.current = entry.revision;
    setBusy(true);
    setError("");
    try { const value = await notesApi.historyVersion(id, entry.revision); if (request.current === token) setVersion(value); }
    catch { if (request.current === token) setError("Couldn't open this version. Please try again."); }
    finally { if (request.current === token) setBusy(false); }
  };

  const restore = async () => {
    if (!version || busy) return;
    setBusy(true);
    setError("");
    try { await onRestore(version.revision); onClose(); }
    catch { setError("Couldn't restore this version. Your current note is unchanged. Please try again."); }
    finally { setBusy(false); }
  };

  return <div className="dialog-backdrop history-backdrop">
    <section ref={dialog} tabIndex={-1} className="history-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="history-heading" aria-describedby="history-description" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="history-heading"><h2 id="history-heading"><History size={18} /> Note history</h2><button ref={closeButton} className="tool" aria-label="Close history" title="Close history" disabled={busy} onClick={onClose}><X size={17} /></button></header>
      <p id="history-description">The last 100 saved versions stay on this device. Restore any version as a new note.</p>
      {error && <p className="history-error" role="alert">{error} <button className="text-action" disabled={busy} onClick={() => { setVersion(null); setAttempt(value => value + 1); }}>Retry</button></p>}
      {loading ? <p role="status">Loading history...</p> : version ? <>
        <button className="history-back" disabled={busy} onClick={() => { setVersion(null); requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>(`[data-revision="${lastRevision.current}"]`)?.focus()); }}><ArrowLeft size={15} /> All versions</button>
        <p className="history-date">{new Date(version.savedAt).toLocaleString()} · Version {version.revision + 1}</p>
        <div className="history-content" tabIndex={0} aria-label="Saved version preview"><HistoryPreview version={version} /></div>
        <button className="dialog-button history-restore" disabled={busy} onClick={() => void restore()}>{busy ? "Restoring..." : "Restore as new note"}</button>
      </> : <div className="history-list" aria-busy={busy}>
        {entries.length === 0 && !error && <p>No earlier versions yet. History appears after you edit and save this note.</p>}
        {entries.map(entry => <button key={entry.revision} data-revision={entry.revision} className="history-entry" disabled={busy} onClick={() => void showVersion(entry)}><span>{entry.title}</span><time dateTime={new Date(entry.savedAt).toISOString()}>{new Date(entry.savedAt).toLocaleString()} · Version {entry.revision + 1}</time><span className="history-excerpt">{entry.preview || "Empty note"}</span></button>)}
      </div>}
    </section>
  </div>;
}
