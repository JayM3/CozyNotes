import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArchiveRestore, ArrowRight, Check, Plus, Search, Settings as SettingsIcon, StickyNote, Trash2, X } from "lucide-react";
import { notesApi, paperColors } from "./api";
import type { LibraryFilter, View } from "./api";
import { Settings } from "./Settings";
import { useLibrarySearch } from "./useLibrarySearch";
import { startWindowDrag } from "./windowDrag";
import cozyLogo from "./assets/cozynotes-logo.png";

type Page = View | "settings";
type Confirmation = {
  title: string;
  message: string;
  actionLabel: string;
  action: () => Promise<unknown>;
  errorMessage: string;
  clearSelectionOnSuccess?: boolean;
  refreshFromEvent?: boolean;
};

function errorText(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function Library() {
  const [page, setPage] = useState<Page>("notes");
  const [view, setView] = useState<View>("notes");
  const [filters, setFilters] = useState<Record<View, LibraryFilter>>({ notes: { query: "", color: null }, trash: { query: "", color: null } });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogWasOpen = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingSearchFocus = useRef(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const filter = filters[view];
  const { notes, error, loading, refresh } = useLibrarySearch(view, filter.query, filter.color);
  const search = useRef<HTMLInputElement>(null);
  const controlsLocked = busy || confirmation !== null;
  const selectionLocked = busy || loading || confirmation !== null;
  const visibleIds = notes.map(note => note.id);
  const selectedCount = selectedIds.size;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some(id => selectedIds.has(id));

  const focusSearch = useCallback(() => {
    if (confirmation || busy) return;
    if (page === "settings") {
      pendingSearchFocus.current = true;
      setPage("notes");
      setView("notes");
      setSelectedIds(new Set());
      return;
    }
    search.current?.focus();
    search.current?.select();
  }, [busy, confirmation, page]);

  useEffect(() => {
    if (page !== "settings" && pendingSearchFocus.current) {
      pendingSearchFocus.current = false;
      search.current?.focus();
      search.current?.select();
    }
  }, [page, view]);

  const create = useCallback(async () => {
    if (busy || confirmation) return;
    setBusy(true);
    try {
      await notesApi.create();
      await refresh();
      setActionError("");
    } catch (error) {
      setActionError(errorText(error, "Couldn't create a note. Check local storage and retry."));
    } finally {
      setBusy(false);
    }
  }, [busy, confirmation, refresh]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === "f") { event.preventDefault(); focusSearch(); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); void create(); }
      if (event.key.toLowerCase() === "w" && !busy && !confirmation) {
        event.preventDefault();
        void getCurrentWindow().close().catch(() => setActionError("Couldn't close the library."));
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [busy, confirmation, create, focusSearch]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen("library-focus-search", focusSearch).then(dispose => {
      if (cancelled) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    if (new URLSearchParams(window.location.search).has("focusSearch")) focusSearch();
    return () => { cancelled = true; unlisten?.(); };
  }, [focusSearch]);

  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];
    const register = (event: string, handler: (payload: unknown) => void) => {
      void listen<unknown>(event, nativeEvent => handler(nativeEvent.payload)).then(dispose => {
        if (cancelled) dispose();
        else disposers.push(dispose);
      }).catch(() => undefined);
    };
    register("library-show-notes", () => {
      if (busy || confirmation) return;
      setSelectedIds(new Set());
      setPage("notes");
      setView("notes");
    });
    return () => {
      cancelled = true;
      disposers.forEach(dispose => dispose());
    };
  }, [busy, confirmation]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let eventGeneration = 0;
    void listen<unknown>("app-error", event => {
      if (cancelled || typeof event.payload !== "string" || !event.payload.trim()) return;
      eventGeneration++;
      setActionError(event.payload);
      void notesApi.takeAppError().catch(() => undefined);
    }).then(async dispose => {
      if (cancelled) { dispose(); return; }
      unlisten = dispose;
      const generation = eventGeneration;
      const queued = await notesApi.takeAppError();
      if (!cancelled && generation === eventGeneration && queued?.trim()) setActionError(queued);
    }).catch(() => undefined);
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (loading || error) return;
    const currentIds = new Set(visibleIds);
    setSelectedIds(current => {
      const retained = new Set([...current].filter(id => currentIds.has(id)));
      return retained.size === current.size ? current : retained;
    });
  }, [error, loading, notes]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  useEffect(() => {
    if (confirmation) {
      dialogWasOpen.current = true;
      cancelConfirmation.current?.focus();
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          setConfirmation(null);
          return;
        }
        if (event.key !== "Tab") return;
        const first = cancelConfirmation.current;
        const last = confirmButton.current;
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      window.addEventListener("keydown", keydown);
      return () => window.removeEventListener("keydown", keydown);
    }
    if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      const target = returnFocus.current;
      returnFocus.current = null;
      if (!busy && target?.isConnected) target.focus();
      else heading.current?.focus();
    }
  }, [busy, confirmation]);

  const navigate = (next: Page) => {
    if (controlsLocked) return;
    setSelectedIds(new Set());
    setPage(next);
    if (next === "notes" || next === "trash") setView(next);
  };

  const updateFilter = (change: Partial<LibraryFilter>) => {
    if (controlsLocked) return;
    setSelectedIds(new Set());
    setFilters(current => ({ ...current, [view]: { ...current[view], ...change } }));
  };

  const actOnNote = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await action();
      setActionError("");
      await refresh();
    } catch (error) {
      setActionError(errorText(error, message));
    } finally {
      setBusy(false);
    }
  };

  const openConfirmation = (next: Confirmation) => {
    if (busy || confirmation) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation(next);
  };

  const purge = (id: string) => openConfirmation({
    title: "Delete note?",
    message: "Permanently delete this note? This cannot be undone.",
    actionLabel: "Delete note",
    action: () => notesApi.purge(id),
    errorMessage: "Couldn't permanently delete this note.",
  });

  const emptyTrash = () => openConfirmation({
    title: "Empty Trash?",
    message: "Permanently delete every note in Trash? This cannot be undone.",
    actionLabel: "Empty Trash",
    action: notesApi.emptyTrash,
    errorMessage: "Couldn't empty Trash.",
  });

  const batchTrash = async () => {
    if (selectionLocked || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    setBusy(true);
    try {
      await notesApi.trashMany(ids);
      setSelectedIds(new Set());
      setActionError("");
    } catch (error) {
      setActionError(errorText(error, "Couldn't move the selected notes to Trash. Retry the operation."));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = () => {
    if (selectionLocked || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const count = ids.length;
    openConfirmation({
      title: `Delete ${count} selected ${count === 1 ? "note" : "notes"}?`,
      message: `Permanently delete ${count} selected ${count === 1 ? "note" : "notes"} from Trash? This cannot be undone.`,
      actionLabel: `Permanently delete ${count} ${count === 1 ? "note" : "notes"}`,
      action: () => notesApi.purgeMany(ids),
      errorMessage: "Couldn't permanently delete the selected notes. Retry the operation.",
      clearSelectionOnSuccess: true,
      refreshFromEvent: true,
    });
  };

  const confirmAction = async () => {
    if (!confirmation || busy) return;
    const current = confirmation;
    setBusy(true);
    setConfirmation(null);
    try {
      await current.action();
      if (current.clearSelectionOnSuccess) setSelectedIds(new Set());
      setActionError("");
      if (!current.refreshFromEvent) await refresh();
    } catch (error) {
      setActionError(errorText(error, current.errorMessage));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelected = (id: string) => {
    if (selectionLocked) return;
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    if (selectionLocked || visibleIds.length === 0) return;
    setSelectedIds(current => {
      const next = new Set(current);
      if (visibleIds.every(id => next.has(id))) visibleIds.forEach(id => next.delete(id));
      else visibleIds.forEach(id => next.add(id));
      return next;
    });
  };

  const clearSelection = () => {
    if (!selectionLocked) setSelectedIds(new Set());
  };

  const displayError = actionError || (page === "settings" ? "" : error);

  return <main className="library-shell">
    <aside className="rail" data-tauri-drag-region onMouseDown={startWindowDrag}>
      <div className="brand" data-tauri-drag-region><img className="brand-logo" src={cozyLogo} alt="CozyNotes" draggable={false} data-tauri-drag-region /><img className="brand-compact" src="/cozynotes-icon.png" alt="CozyNotes" draggable={false} data-tauri-drag-region /></div>
      <button className="new-note" onClick={() => void create()} disabled={controlsLocked} aria-label="New note" title="New note"><Plus size={17} /> New note</button>
      <nav aria-label="Library">
        <button className={page === "notes" ? "nav-item active" : "nav-item"} aria-current={page === "notes" ? "page" : undefined} aria-label="Notes" title="Notes" onClick={() => navigate("notes")} disabled={controlsLocked}><StickyNote size={16} /> Notes</button>
        <button className={page === "trash" ? "nav-item active" : "nav-item"} aria-current={page === "trash" ? "page" : undefined} aria-label="Trash" title="Trash" onClick={() => navigate("trash")} disabled={controlsLocked}><Trash2 size={16} /> Trash</button>
      </nav>
      <div className="rail-bottom">
        <button className={page === "settings" ? "nav-item active settings-nav" : "nav-item settings-nav"} aria-current={page === "settings" ? "page" : undefined} aria-label="Settings" title="Settings" onClick={() => navigate("settings")} disabled={controlsLocked}><SettingsIcon size={16} /> Settings</button>
        <div className="rail-foot" title="Stored on this device"><span className="local-indicator" /> Stored on this device</div>
      </div>
    </aside>
    <section className="library-content">
      <header className="library-header" data-tauri-drag-region onMouseDown={startWindowDrag}>
        <div data-tauri-drag-region><h1 ref={heading} tabIndex={-1} data-tauri-drag-region>{page === "settings" ? "Settings" : page === "notes" ? "Notes" : "Trash"}</h1></div>
        <div className="header-actions">{page === "trash" && <button className="text-action empty-trash" onClick={emptyTrash} disabled={controlsLocked}>Empty Trash</button>}<button className="icon-button" aria-label="Close library" title="Close library" disabled={controlsLocked} onClick={() => { void getCurrentWindow().close().catch(() => setActionError("Couldn't close the library.")); }}><X size={17} /></button></div>
      </header>
      {displayError && <p className="error-banner" role="alert">{displayError} {error && page !== "settings" && <button className="text-action" onClick={() => void refresh()} disabled={controlsLocked}>Retry</button>}</p>}
      {page === "settings" ? <Settings /> : <>
        <label className="search-box"><Search size={17} /><input ref={search} type="search" aria-label={view === "notes" ? "Search notes" : "Search trash"} placeholder={view === "notes" ? "Search your notes" : "Search trash"} value={filter.query} onChange={event => updateFilter({ query: event.target.value })} disabled={controlsLocked} /></label>
        <div className="color-filters" role="group" aria-label="Filter by paper color">
          <button className="all-colors" aria-pressed={filter.color === null} onClick={() => updateFilter({ color: null })} disabled={controlsLocked}>All colors</button>
          {paperColors.map(color => <button key={color} className={`filter-swatch paper-${color}`} aria-label={`${color[0].toUpperCase()}${color.slice(1)} paper`} title={`${color[0].toUpperCase()}${color.slice(1)} paper`} aria-pressed={filter.color === color} onClick={() => updateFilter({ color })} disabled={controlsLocked}><span className="swatch-face">{filter.color === color && <Check size={14} />}</span></button>)}
        </div>
        <div className="list-heading"><span aria-live="polite">{loading ? "Searching..." : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`}</span><span>Recently edited</span></div>
        {notes.length > 0 && <div className="selection-toolbar" aria-label="Note selection actions">
          <span className="selection-count" role={selectedCount ? "status" : undefined}>{selectedCount ? `${selectedCount} selected` : "Select notes"}</span>
          <label className="select-all-control"><input ref={selectAllRef} type="checkbox" aria-label="Select all visible notes" aria-checked={someVisibleSelected ? "mixed" : allVisibleSelected} checked={allVisibleSelected} onChange={toggleAllVisible} disabled={selectionLocked} /><span>Select all</span></label>
          <button className="selection-clear" onClick={clearSelection} disabled={selectionLocked || selectedCount === 0}>Clear</button>
          {view === "notes"
            ? <button className="selection-delete" onClick={() => void batchTrash()} disabled={selectionLocked || selectedCount === 0}><Trash2 size={15} /> Move to Trash</button>
            : <button className="selection-delete" onClick={deleteSelected} disabled={selectionLocked || selectedCount === 0}><Trash2 size={15} /> Delete selected</button>}
        </div>}
        <div className="note-list" aria-busy={loading}>
          {notes.map(note => <article className={`note-row paper-${note.color}`} key={note.id}>
            <button className="note-open" onClick={() => { if (view === "notes") void actOnNote(() => notesApi.open(note.id), "Couldn't open this note."); }} disabled={view === "trash" || controlsLocked || loading}>
              <span className="note-title">{note.title}</span><span className="note-preview">{note.snippet.length ? note.snippet.map((segment, index) => segment.matched ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>) : note.preview || "No text yet"}</span>
              <time dateTime={new Date(note.updatedAt).toISOString()}>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
            </button>
            {view === "trash" && <><button className="row-action" onClick={() => void actOnNote(() => notesApi.restore(note.id), "Couldn't restore this note.")} aria-label={`Restore ${note.title}`} title="Restore note" disabled={controlsLocked || loading}><ArchiveRestore size={17} /></button><button className="row-action" onClick={() => purge(note.id)} aria-label={`Permanently delete ${note.title}`} title="Permanently delete" disabled={controlsLocked || loading}><Trash2 size={16} /></button></>}
            <span className={`selection-control paper-${note.color}`}>
              <input className="selection-checkbox" type="checkbox" aria-label={`Select ${note.title}`} checked={selectedIds.has(note.id)} onChange={() => toggleSelected(note.id)} disabled={selectionLocked} />
              <span className="selection-mark" aria-hidden="true"><Check size={14} /></span>
            </span>
          </article>)}
          {!notes.length && !loading && <div className="empty-state">{!filter.query && !filter.color && view === "notes" ? <img className="empty-notebook" src="/cozynotes-icon.png" alt="" draggable={false} /> : <StickyNote size={28} aria-hidden="true" />}<h2>{filter.query || filter.color ? "No notes match your search" : view === "notes" ? "No notes yet" : "Trash is empty"}</h2>{!filter.query && !filter.color && view === "notes" && <button className="text-action" onClick={() => void create()} disabled={controlsLocked}>Create a note <ArrowRight size={14} /></button>}</div>}
        </div>
      </>}
    </section>
    {confirmation && <div className="dialog-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message">
        <div className="confirm-dialog-icon" aria-hidden="true"><Trash2 size={18} /></div>
        <div className="confirm-dialog-copy">
          <h2 id="confirm-dialog-title">{confirmation.title}</h2>
          <p id="confirm-dialog-message">{confirmation.message}</p>
        </div>
        <div className="confirm-dialog-actions">
          <button ref={cancelConfirmation} className="dialog-button secondary" onClick={() => { if (!busy) setConfirmation(null); }} disabled={busy}>Cancel</button>
          <button ref={confirmButton} className="dialog-button danger" onClick={() => void confirmAction()} disabled={busy}>{confirmation.actionLabel}</button>
        </div>
      </section>
    </div>}
  </main>;
}
