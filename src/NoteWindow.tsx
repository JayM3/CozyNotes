import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import type { SelectionBookmark } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { AArrowDown, AArrowUp, ArrowDown, ArrowUp, Bold, Check, CheckSquare, Copy, Italic, List, MoreHorizontal, Plus, RotateCcw, Search, Trash2, Underline as UnderlineIcon, X } from "lucide-react";
import { notesApi, paperColors } from "./api";
import type { Note, PaperColor } from "./api";
import { SaveCoordinator } from "./saveCoordinator";
import type { SaveStatus } from "./saveCoordinator";
import { clearFind, FindExtension, getFindState, hasCompletedTasks, resetCompletedTasks, setFindQuery, stepFind } from "./editorTools";
import { Popover } from "./Popover";
import { startWindowDrag } from "./windowDrag";
import { ThemeMenuItems } from "./ThemePicker";

const readingSizes = [12, 14, 16, 18, 20, 24];

export function NoteWindow({ id }: { id: string }) {
  const nativeWindow = useMemo(() => getCurrentWindow(), []);
  const [note, setNote] = useState<Note | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | "loading">("loading");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [locked, setLocked] = useState(false);
  const [closeReady, setCloseReady] = useState(false);
  const [fontSize, setFontSize] = useState(16);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setQuery] = useState("");
  const findInput = useRef<HTMLInputElement>(null);
  const bookmark = useRef<SelectionBookmark | null>(null);
  const coordinator = useRef<SaveCoordinator<JSONContent, Note> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const allowClose = useRef(false);
  const actionInFlight = useRef<Promise<boolean> | null>(null);
  const actionKind = useRef<string | null>(null);
  const closeRef = useRef<() => void>(() => undefined);
  const initialFocus = useRef(false);

  const editor = useEditor({
    extensions: [StarterKit.configure({ underline: false, link: { openOnClick: false } }), Underline, TaskList, TaskItem.configure({ nested: true }), FindExtension],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editable: false,
    enableContentCheck: true,
    editorProps: {
      attributes: { class: "note-editor", "aria-label": "Note text", role: "textbox", "aria-multiline": "true" },
      handleDOMEvents: {
        compositionstart: () => { coordinator.current?.setComposing(true); return false; },
        compositionend: () => { window.setTimeout(() => coordinator.current?.setComposing(false), 0); return false; },
      },
    },
    onUpdate: ({ editor: updated }) => coordinator.current?.markDirty(updated.getJSON()),
    onBlur: () => { void coordinator.current?.flush().catch(() => undefined); },
    onTransaction: ({ transaction }) => { if (bookmark.current && transaction.docChanged) bookmark.current = bookmark.current.map(transaction.mapping); },
  });
  editorRef.current = editor;

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      underline: current?.isActive("underline") ?? false,
      bullet: current?.isActive("bulletList") ?? false,
      task: current?.isActive("taskList") ?? false,
      completed: hasCompletedTasks(current),
      find: getFindState(current),
    }),
  });

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    editor.setEditable(false, false);
    setLoadError(false);
    setSaveStatus("loading");
    setError("");
    void notesApi.get(id).then(value => {
      if (cancelled || editor.isDestroyed) return;
      setNote(value);
      if (!value.document || value.documentError) throw new Error(value.documentError || "The saved document is unreadable.");
      editor.schema.nodeFromJSON(value.document).check();
      editor.commands.setContent(value.document, { emitUpdate: false, errorOnInvalidContent: true });
      coordinator.current = new SaveCoordinator({
        revision: value.revision,
        save: (document, revision) => notesApi.save(id, revision, document),
        onSaved: saved => setNote(current => current ? { ...saved, color: current.color } : saved),
        onStatus: status => {
          setSaveStatus(status);
          setError(status === "error" ? "Couldn't save. Your draft is still open." : "");
        },
      });
      setSaveStatus("saved");
    }).catch(() => {
      if (!cancelled) { setLoadError(true); setSaveStatus("error"); setError("This note couldn't be opened for editing. Its stored data has been preserved."); }
    });
    return () => { cancelled = true; coordinator.current?.dispose(); coordinator.current = null; };
  }, [id, editor, loadAttempt]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const editable = Boolean(coordinator.current) && closeReady && !locked && !loadError;
    editor.setEditable(editable, false);
    if (editable && !initialFocus.current) { initialFocus.current = true; editor.commands.focus("end"); }
  }, [editor, note, closeReady, locked, loadError]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void nativeWindow.onCloseRequested(event => {
      if (allowClose.current) return;
      event.preventDefault();
      closeRef.current();
    }).then(unlisten => {
      if (cancelled) unlisten();
      else { dispose = unlisten; setCloseReady(true); }
    }).catch(() => { if (!cancelled) setError("Couldn't prepare this window for safe editing. Reopen the note to retry."); });
    return () => { cancelled = true; dispose?.(); };
  }, [nativeWindow]);

  const savedAction = useCallback(function runSavedAction(action: () => Promise<unknown>, failure: string, kind: string): Promise<boolean> {
    if (actionInFlight.current) {
      return actionKind.current === kind ? actionInFlight.current
        : actionInFlight.current.then(success => success ? runSavedAction(action, failure, kind) : false);
    }
    actionKind.current = kind;
    actionInFlight.current = (async () => {
      try {
        await coordinator.current?.waitUntilCompositionEnds();
        if (editorRef.current && !editorRef.current.isDestroyed) editorRef.current.setEditable(false, false);
        setLocked(true);
        await coordinator.current?.flush();
        await action();
        return true;
      } catch {
        allowClose.current = false;
        setError(failure);
        return false;
      } finally {
        actionInFlight.current = null;
        actionKind.current = null;
        setLocked(false);
        if (coordinator.current && editorRef.current && !editorRef.current.isDestroyed) editorRef.current.setEditable(true, false);
      }
    })();
    return actionInFlight.current;
  }, []);

  const close = useCallback(() => savedAction(async () => { allowClose.current = true; await nativeWindow.close(); }, "Your draft is still open. Save before closing this note.", "close"), [nativeWindow, savedAction]);
  closeRef.current = () => { void close(); };
  const trash = () => savedAction(async () => { await notesApi.trash(id); allowClose.current = true; await nativeWindow.close(); }, "Couldn't save or move this note to Trash.", "trash");
  const duplicate = () => savedAction(() => notesApi.duplicate(id), "Couldn't save or duplicate this note.", "duplicate");
  const retry = async () => {
    if (loadError) { setLoadAttempt(value => value + 1); return; }
    try { await coordinator.current?.flush(); }
    catch { setError("Couldn't save. Your draft is still open."); }
  };
  const copyDraft = async () => {
    try { await navigator.clipboard.writeText(loadError ? note?.plainText ?? "" : editor?.getText() ?? ""); }
    catch { setError("Couldn't copy the text. Your draft is still open."); }
  };
  const command = (run: (current: Editor) => void) => { if (editor?.isEditable) { run(editor); editor.commands.focus(); } };
  const changeColor = async (color: PaperColor) => {
    try { await notesApi.color(id, color); setNote(current => current ? { ...current, color } : current); }
    catch { setError("Couldn't change paper color."); }
  };
  const openFind = useCallback(() => {
    if (!editor || !coordinator.current) return;
    if (!bookmark.current) bookmark.current = editor.state.selection.getBookmark();
    setFindOpen(true);
    setFindQuery(editor, findQuery);
    window.requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  }, [editor, findQuery]);
  const dismissFind = useCallback(() => {
    setFindOpen(false);
    if (!editor) return;
    clearFind(editor);
    if (bookmark.current) {
      editor.view.dispatch(editor.state.tr.setSelection(bookmark.current.resolve(editor.state.doc)).setMeta("addToHistory", false));
      bookmark.current = null;
    }
    editor.commands.focus();
  }, [editor]);
  const changeReadingSize = (direction: number) => setFontSize(value => readingSizes[Math.max(0, Math.min(readingSizes.length - 1, readingSizes.indexOf(value) + direction))]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const primary = (event.metaKey || event.ctrlKey) && !event.altKey;
      if (primary && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (event.shiftKey) void notesApi.showLibrary(true).catch(() => setError("Couldn't open library search."));
        else openFind();
      }
      if (primary && event.key.toLowerCase() === "w") { event.preventDefault(); void close(); }
      if (primary && event.key.toLowerCase() === "n") { event.preventDefault(); void notesApi.create().catch(() => setError("Couldn't create a note.")); }
      if (primary && ["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "0") setFontSize(16);
        else changeReadingSize(event.key === "-" ? -1 : 1);
      }
      if (event.key === "Escape" && findOpen && !event.defaultPrevented) { event.preventDefault(); dismissFind(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, openFind, dismissFind, findOpen]);

  const activeIndex = state?.find.activeIndex ?? -1;
  const matchCount = state?.find.matches.length ?? 0;
  useEffect(() => {
    if (findOpen) editor?.view.dom.querySelector('[data-find-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [editor, findOpen, activeIndex, matchCount, findQuery]);

  const ready = Boolean(note) && !loadError && closeReady;
  const statusText = saveStatus === "loading" ? "Loading..." : saveStatus === "saving" ? "Saving..." : saveStatus === "error" ? "Couldn't save" : "Saved on this device";
  return <main className={`note-window paper-${note?.color ?? "cream"}`}>
    <header className="note-toolbar" data-tauri-drag-region onMouseDown={startWindowDrag}>
      <div className="toolbar-group" role="group" aria-label="Text formatting" data-tauri-drag-region>
        <button className={`tool ${state?.bold ? "active" : ""}`} disabled={!ready || locked} aria-label="Bold" title="Bold" aria-pressed={state?.bold ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleBold().run())}><Bold size={16} /></button>
        <button className={`tool secondary-format ${state?.italic ? "active" : ""}`} disabled={!ready || locked} aria-label="Italic" title="Italic" aria-pressed={state?.italic ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleItalic().run())}><Italic size={16} /></button>
        <button className={`tool secondary-format ${state?.underline ? "active" : ""}`} disabled={!ready || locked} aria-label="Underline" title="Underline" aria-pressed={state?.underline ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleUnderline().run())}><UnderlineIcon size={16} /></button>
        <button className={`tool secondary-format ${state?.bullet ? "active" : ""}`} disabled={!ready || locked} aria-label="Bullet list" title="Bullet list" aria-pressed={state?.bullet ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleBulletList().run())}><List size={16} /></button>
        <button className={`tool secondary-format ${state?.task ? "active" : ""}`} disabled={!ready || locked} aria-label="Checklist" title="Checklist" aria-pressed={state?.task ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleTaskList().run())}><CheckSquare size={16} /></button>
      </div>
      <div className="note-actions" data-tauri-drag-region>
        <Popover label="Paper color" icon={<span className={`current-paper paper-${note?.color ?? "cream"}`} />} disabled={!ready || locked}>
          {paperColors.map(color => <button key={color} role="menuitemradio" aria-checked={note?.color === color} onClick={() => void changeColor(color)}><span className={`menu-swatch paper-${color}`} />{color[0].toUpperCase() + color.slice(1)}{note?.color === color && <Check size={15} className="menu-check" />}</button>)}
        </Popover>
        <Popover label="More note actions" icon={<MoreHorizontal size={17} />}>
          <button role="menuitem" disabled={!ready || locked} onClick={openFind}><Search size={15} /> Find in note</button>
          <button role="menuitem" data-editor-action disabled={!ready || locked || !state?.completed} onClick={() => command(resetCompletedTasks)}><RotateCcw size={15} /> Reset completed items</button>
          <button role="menuitem" disabled={!ready || locked} onClick={() => void duplicate()}><Copy size={15} /> Duplicate</button>
          <button role="menuitem" onClick={() => void notesApi.create().catch(() => setError("Couldn't create a note."))}><Plus size={15} /> New note</button>
          <button role="menuitem" onClick={() => void notesApi.showLibrary().catch(() => setError("Couldn't show the library."))}><List size={15} /> Show library</button>
          <div className="menu-section-label" role="presentation">Appearance</div>
          <ThemeMenuItems />
          <div className="compact-formats" role="group" aria-label="Text formatting">
            <button role="menuitem" data-editor-action disabled={!ready || locked} onClick={() => command(current => current.chain().toggleItalic().run())}><Italic size={15} /> Italic</button>
            <button role="menuitem" data-editor-action disabled={!ready || locked} onClick={() => command(current => current.chain().toggleUnderline().run())}><UnderlineIcon size={15} /> Underline</button>
            <button role="menuitem" data-editor-action disabled={!ready || locked} onClick={() => command(current => current.chain().toggleBulletList().run())}><List size={15} /> Bullet list</button>
            <button role="menuitem" data-editor-action disabled={!ready || locked} onClick={() => command(current => current.chain().toggleTaskList().run())}><CheckSquare size={15} /> Checklist</button>
          </div>
          <button role="menuitem" disabled={!ready || locked} className="danger-action" onClick={() => void trash()}><Trash2 size={15} /> Move to Trash</button>
          <button role="menuitem" onClick={() => void close()}><X size={15} /> Close note</button>
        </Popover>
        <button className="tool close-tool" onClick={() => void close()} aria-label="Close note" title="Close note"><X size={17} /></button>
      </div>
    </header>
    {findOpen && <div className="find-bar" role="search" aria-label="Find in note">
      <label className="find-field"><Search size={15} /><input ref={findInput} aria-label="Find in note" placeholder="Find in note" value={findQuery} onChange={event => { setQuery(event.target.value); if (editor) setFindQuery(editor, event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (editor) stepFind(editor, event.shiftKey ? -1 : 1); } }} /></label>
      <span className="find-count" role="status" aria-live="polite">{activeIndex + 1} of {matchCount}</span>
      <button className="tool" aria-label="Previous match" title="Previous match" disabled={!matchCount} onClick={() => editor && stepFind(editor, -1)}><ArrowUp size={16} /></button>
      <button className="tool" aria-label="Next match" title="Next match" disabled={!matchCount} onClick={() => editor && stepFind(editor, 1)}><ArrowDown size={16} /></button>
      <button className="tool" aria-label="Close find" title="Close find" onClick={dismissFind}><X size={16} /></button>
    </div>}
    <section className="note-body" style={{ "--reading-size": `${fontSize}px` } as CSSProperties}>
      {error && <div className="save-error" role="alert">{error}<div className="error-actions"><button onClick={() => void retry()}>Retry</button><button onClick={() => void copyDraft()}>{loadError ? "Copy available text" : "Copy draft"}</button></div></div>}
      {loadError && note?.plainText ? <pre className="recovery-text">{note.plainText}</pre> : <EditorContent editor={editor} />}
    </section>
    <footer className="note-footer" data-tauri-drag-region onMouseDown={startWindowDrag}><span className={`save-indicator status-${saveStatus}`} data-tauri-drag-region /><span className="save-label" data-tauri-drag-region>{statusText}</span><div className="reading-controls"><button aria-label="Decrease text size" title="Decrease text size" disabled={fontSize === 12} onClick={() => changeReadingSize(-1)}><AArrowDown size={16} /></button><button aria-label="Increase text size" title="Increase text size" disabled={fontSize === 24} onClick={() => changeReadingSize(1)}><AArrowUp size={16} /></button></div></footer>
  </main>;
}
