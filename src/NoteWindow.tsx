import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import type { SelectionBookmark } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { AArrowDown, AArrowUp, ArrowDown, ArrowUp, Bold, Check, CheckSquare, Copy, ImagePlus, Italic, List, MoreHorizontal, Plus, RotateCcw, Search, Trash2, Underline as UnderlineIcon, X } from "lucide-react";
import { notesApi, paperColors } from "./api";
import type { Note, NoteDraft, PaperColor } from "./api";
import { SaveCoordinator } from "./saveCoordinator";
import type { SaveStatus } from "./saveCoordinator";
import { clearFind, FindExtension, getFindState, hasCompletedTasks, resetCompletedTasks, setFindQuery, setFindTitle, stepFind } from "./editorTools";
import { NoteTitle } from "./NoteTitle";
import { Popover } from "./Popover";
import { startWindowDrag } from "./windowDrag";
import { ThemeMenuItems } from "./ThemePicker";
import { EditorOperationCoordinator } from "./editorOperation";
import type { EditorOperation, EditorOperationFinish } from "./editorOperation";
import { KeepOnTopButton, useKeepOnTop } from "./KeepOnTop";
import { CozyImage } from "./ImageNode";
import { imageFiles, imageType, MAX_IMAGE_BYTES } from "./imageImport";

const readingSizes = [12, 14, 16, 18, 20, 24];
export function NoteWindow({ id }: { id: string }) {
  const nativeWindow = useMemo(() => getCurrentWindow(), []);
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const titleValue = useRef("");
  const titleInput = useRef<HTMLInputElement>(null);
  const titleSelection = useRef<{ from: number; to: number } | null>(null);
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
  const coordinator = useRef<SaveCoordinator<NoteDraft, Note> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const imageFileInput = useRef<HTMLInputElement>(null);
  const allowClose = useRef(false);
  const actionInFlight = useRef<Promise<boolean> | null>(null);
  const actionKind = useRef<string | null>(null);
  const closeRef = useRef<() => void>(() => undefined);
  const nativeOperation = useRef<EditorOperationCoordinator | null>(null);
  const initialFocus = useRef(false);
  const keepOnTop = useKeepOnTop(nativeWindow);

  const importImages = useCallback(async (files: File[]) => {
    const current = editorRef.current;
    if (!current?.isEditable || !coordinator.current) return;
    const savedAssets: Array<{ assetId: string; alt: string }> = [];
    try {
      for (const file of files) {
        const mimeType = imageType(file);
        if (!mimeType) {
          throw new Error("This image format is not supported. Use PNG, JPEG, GIF, WebP, or BMP.");
        }
        if (file.size > MAX_IMAGE_BYTES) {
          throw new Error("Images must be 25 MB or smaller.");
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const asset = await notesApi.saveImage(mimeType, bytes);
        savedAssets.push({ assetId: asset.assetId, alt: file.name || "Pasted image" });
      }
      if (!current.isEditable || current.isDestroyed) throw new Error("The note is no longer editable.");
      const inserted = current.chain().focus().insertContent(savedAssets.map(asset => ({
        type: "image",
        attrs: { assetId: asset.assetId, alt: asset.alt },
      }))).run();
      if (!inserted) throw new Error("Couldn't insert the image. The note was not changed.");
      setError("");
    } catch (cause) {
      await Promise.all(savedAssets.map(asset => notesApi.deleteImage(asset.assetId).catch(() => undefined)));
      setError(cause instanceof Error && cause.message ? cause.message : "Couldn't import the image. The note was not changed.");
    }
  }, []);

  const editor = useEditor({
    extensions: [StarterKit.configure({ underline: false, link: { openOnClick: false } }), Underline, TaskList, TaskItem.configure({ nested: true }), CozyImage, FindExtension],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editable: false,
    enableContentCheck: true,
    editorProps: {
      attributes: { class: "note-editor", "aria-label": "Note text", role: "textbox", "aria-multiline": "true" },
      handleDOMEvents: {
        compositionstart: () => { coordinator.current?.setComposing(true); return false; },
        compositionend: () => { window.setTimeout(() => coordinator.current?.setComposing(false), 0); return false; },
      },
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        void importImages(files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = imageFiles(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (position) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position.pos))));
        void importImages(files);
        return true;
      },
    },
    onUpdate: ({ editor: updated }) => coordinator.current?.markDirty({ document: updated.getJSON(), explicitTitle: titleValue.current }),
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
      titleValue.current = value.explicitTitle;
      setTitle(value.explicitTitle);
      if (!value.document || value.documentError) throw new Error(value.documentError || "The saved document is unreadable.");
      editor.schema.nodeFromJSON(value.document).check();
      editor.commands.setContent(value.document, { emitUpdate: false, errorOnInvalidContent: true });
      setFindTitle(editor, value.explicitTitle);
      coordinator.current = new SaveCoordinator({
        revision: value.revision,
        save: (draft, revision) => notesApi.save(id, revision, draft),
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
    if (titleInput.current) titleInput.current.readOnly = !editable;
    if (editable && !initialFocus.current) {
      initialFocus.current = true;
      if (!titleValue.current && editor.isEmpty) titleInput.current?.focus();
      else editor.commands.focus("end");
    }
  }, [editor, note, closeReady, locked, loadError]);

  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];
    const operation = new EditorOperationCoordinator({
      isActive: operationId => invoke<boolean>("editor_operation_active", { operationId }),
      waitForIdle: async () => {
        if (actionInFlight.current && !await actionInFlight.current) throw new Error("The current note action failed.");
      },
      waitForComposition: async () => { await coordinator.current?.waitUntilCompositionEnds(); },
      setLocked: value => {
        if (cancelled) return;
        setLocked(value);
        if (titleInput.current) titleInput.current.readOnly = value || !coordinator.current;
        if (value && editorRef.current && !editorRef.current.isDestroyed) editorRef.current.setEditable(false, false);
      },
      flush: async () => { await coordinator.current?.flush(); },
      acknowledge: (operationId, success) => invoke<void>("ack_editor_operation", { operationId, success }),
      onCommitted: () => { if (!cancelled) setError("This note was moved to Trash. Close this window to continue."); },
      onError: message => { if (!cancelled) setError(message); },
    });
    nativeOperation.current = operation;
    const failed = () => { if (!cancelled) setError("Couldn't prepare this window for safe editing. Reopen the note to retry."); };
    const registrations = [
      nativeWindow.onCloseRequested(event => {
        if (allowClose.current || operation.canClose) return;
        event.preventDefault();
        closeRef.current();
      }),
      listen<EditorOperation>("prepare-editor-operation", event => { void operation.prepare(event.payload).catch(failed); }),
      listen<EditorOperationFinish>("finish-editor-operation", event => { void operation.finish(event.payload).catch(failed); }),
    ];
    void Promise.all(registrations.map(registration => registration.then(dispose => {
      if (cancelled) dispose();
      else disposers.push(dispose);
    }))).then(() => { if (!cancelled) setCloseReady(true); }).catch(failed);
    return () => {
      cancelled = true;
      operation.dispose();
      if (nativeOperation.current === operation) nativeOperation.current = null;
      disposers.forEach(dispose => dispose());
    };
  }, [nativeWindow]);

  const savedAction = useCallback(function runSavedAction(action: () => Promise<unknown>, failure: string, kind: string): Promise<boolean> {
    if (nativeOperation.current?.busy) return Promise.resolve(false);
    if (actionInFlight.current) {
      return actionKind.current === kind ? actionInFlight.current
        : actionInFlight.current.then(success => success ? runSavedAction(action, failure, kind) : false);
    }
    actionKind.current = kind;
    actionInFlight.current = (async () => {
      try {
        await coordinator.current?.waitUntilCompositionEnds();
        if (editorRef.current && !editorRef.current.isDestroyed) editorRef.current.setEditable(false, false);
        if (titleInput.current) titleInput.current.readOnly = true;
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
        if (titleInput.current) titleInput.current.readOnly = !coordinator.current;
        if (coordinator.current && editorRef.current && !editorRef.current.isDestroyed) editorRef.current.setEditable(true, false);
      }
    })();
    return actionInFlight.current;
  }, []);

  const close = useCallback(async () => {
    if (nativeOperation.current?.canClose) {
      try { await nativeWindow.close(); return true; }
      catch { setError("This note is in Trash, but the window couldn't close. Retry Close note."); return false; }
    }
    return savedAction(async () => { allowClose.current = true; await nativeWindow.close(); }, "Your draft is still open. Save before closing this note.", "close");
  }, [nativeWindow, savedAction]);
  closeRef.current = () => { void close(); };
  const trash = () => savedAction(async () => { await notesApi.trash(id); allowClose.current = true; await nativeWindow.close(); }, "Couldn't save or move this note to Trash.", "trash");
  const duplicate = () => savedAction(() => notesApi.duplicate(id), "Couldn't save or duplicate this note.", "duplicate");
  const retry = async () => {
    if (loadError) { setLoadAttempt(value => value + 1); return; }
    if (nativeOperation.current && !await nativeOperation.current.retryFinish()) return;
    try { await coordinator.current?.flush(); setError(""); }
    catch { setError("Couldn't save. Your draft is still open."); }
  };
  const copyDraft = async () => {
    const body = loadError ? note?.plainText ?? "" : editor?.getText() ?? "";
    try { await navigator.clipboard.writeText(titleValue.current ? `${titleValue.current}\n\n${body}` : body); }
    catch { setError("Couldn't copy the text. Your draft is still open."); }
  };
  const windowAction = useCallback(async (action: () => Promise<unknown>, failure: string) => {
    if (nativeOperation.current?.busy) return;
    try { await action(); }
    catch { setError(failure); }
  }, []);
  const command = (run: (current: Editor) => void) => { if (editor?.isEditable) { run(editor); editor.commands.focus(); } };
  const chooseImage = () => { if (editor?.isEditable) imageFileInput.current?.click(); };
  const changeColor = async (color: PaperColor) => {
    try { await notesApi.color(id, color); setNote(current => current ? { ...current, color } : current); }
    catch { setError("Couldn't change paper color."); }
  };
  const openFind = useCallback(() => {
    if (!editor || !coordinator.current) return;
    if (!bookmark.current) {
      bookmark.current = editor.state.selection.getBookmark();
      titleSelection.current = document.activeElement === titleInput.current
        ? { from: titleInput.current?.selectionStart ?? 0, to: titleInput.current?.selectionEnd ?? 0 } : null;
    }
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
    if (titleSelection.current) {
      titleInput.current?.focus();
      titleInput.current?.setSelectionRange(titleSelection.current.from, titleSelection.current.to);
      titleSelection.current = null;
    } else editor.commands.focus();
  }, [editor]);
  const changeTitle = (value: string) => {
    if (!editor?.isEditable || !coordinator.current || titleInput.current?.readOnly) return;
    titleValue.current = value;
    setTitle(value);
    setFindTitle(editor, value);
    coordinator.current.markDirty({ document: editor.getJSON(), explicitTitle: value });
  };
  const changeReadingSize = (direction: number) => setFontSize(value => readingSizes[Math.max(0, Math.min(readingSizes.length - 1, readingSizes.indexOf(value) + direction))]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const primary = (event.metaKey || event.ctrlKey) && !event.altKey;
      if (primary && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (event.shiftKey) void windowAction(() => notesApi.showLibrary(true), "Couldn't open library search.");
        else openFind();
      }
      if (primary && event.key.toLowerCase() === "w") { event.preventDefault(); void close(); }
      if (primary && event.key.toLowerCase() === "n") { event.preventDefault(); void windowAction(notesApi.create, "Couldn't create a note."); }
      if (primary && ["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "0") setFontSize(16);
        else changeReadingSize(event.key === "-" ? -1 : 1);
      }
      if (event.key === "Escape" && findOpen && !event.defaultPrevented) { event.preventDefault(); dismissFind(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, openFind, dismissFind, findOpen, windowAction]);

  const activeIndex = state?.find.activeIndex ?? -1;
  const matchCount = state?.find.matches.length ?? 0;
  useEffect(() => {
    if (findOpen) editor?.view.dom.querySelector('[data-find-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [editor, findOpen, activeIndex, matchCount, findQuery]);

  const ready = Boolean(note) && !loadError && closeReady;
  return <main className={`note-window paper-${note?.color ?? "cream"}`} style={{ "--reading-size": `${fontSize}px` } as CSSProperties}>
    <header className="note-toolbar" data-tauri-drag-region onMouseDown={startWindowDrag}>
      <div className="toolbar-group" role="group" aria-label="Text formatting" data-tauri-drag-region>
        <button className="tool" disabled={!ready || locked} aria-label="Insert image" title="Insert image" onMouseDown={event => event.preventDefault()} onClick={chooseImage}><ImagePlus size={16} /></button>
        <button className={`tool ${state?.bold ? "active" : ""}`} disabled={!ready || locked} aria-label="Bold" title="Bold" aria-pressed={state?.bold ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleBold().run())}><Bold size={16} /></button>
        <button className={`tool secondary-format ${state?.italic ? "active" : ""}`} disabled={!ready || locked} aria-label="Italic" title="Italic" aria-pressed={state?.italic ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleItalic().run())}><Italic size={16} /></button>
        <button className={`tool secondary-format ${state?.underline ? "active" : ""}`} disabled={!ready || locked} aria-label="Underline" title="Underline" aria-pressed={state?.underline ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleUnderline().run())}><UnderlineIcon size={16} /></button>
        <button className={`tool secondary-format ${state?.bullet ? "active" : ""}`} disabled={!ready || locked} aria-label="Bullet list" title="Bullet list" aria-pressed={state?.bullet ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleBulletList().run())}><List size={16} /></button>
        <button className={`tool secondary-format ${state?.task ? "active" : ""}`} disabled={!ready || locked} aria-label="Checklist" title="Checklist" aria-pressed={state?.task ?? false} onMouseDown={event => event.preventDefault()} onClick={() => command(current => current.chain().toggleTaskList().run())}><CheckSquare size={16} /></button>
      </div>
      <div className="note-actions" data-tauri-drag-region>
        <KeepOnTopButton controller={keepOnTop} disabled={!ready || locked} />
        <Popover label="Paper color" icon={<span className={`current-paper paper-${note?.color ?? "cream"}`} />} disabled={!ready || locked}>
          {paperColors.map(color => <button key={color} role="menuitemradio" aria-checked={note?.color === color} onClick={() => void changeColor(color)}><span className={`menu-swatch paper-${color}`} />{color[0].toUpperCase() + color.slice(1)}{note?.color === color && <Check size={15} className="menu-check" />}</button>)}
        </Popover>
        <Popover label="More note actions" icon={<MoreHorizontal size={17} />}>
          <button role="menuitem" disabled={!ready || locked} onClick={openFind}><Search size={15} /> Find in note</button>
          <button role="menuitem" data-editor-action disabled={!ready || locked || !state?.completed} onClick={() => command(resetCompletedTasks)}><RotateCcw size={15} /> Reset completed items</button>
          <button role="menuitem" disabled={!ready || locked} onClick={() => void duplicate()}><Copy size={15} /> Duplicate</button>
          <button role="menuitem" disabled={locked} onClick={() => void windowAction(notesApi.create, "Couldn't create a note.")}><Plus size={15} /> New note</button>
          <button role="menuitem" disabled={locked} onClick={() => void windowAction(() => notesApi.showLibrary(), "Couldn't show the library.")}><List size={15} /> Show library</button>
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
    {keepOnTop.error && <div className="keep-on-top-error" role="alert"><span>{keepOnTop.error}</span><button type="button" disabled={locked || keepOnTop.pending} onClick={() => void keepOnTop.retry()}>Retry</button></div>}
    {findOpen && <div className="find-bar" role="search" aria-label="Find in note">
      <label className="find-field"><Search size={15} /><input ref={findInput} aria-label="Find in note" placeholder="Find in note" value={findQuery} onChange={event => { setQuery(event.target.value); if (editor) setFindQuery(editor, event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (editor) stepFind(editor, event.shiftKey ? -1 : 1); } }} /></label>
      <span className="find-count" role="status" aria-live="polite">{activeIndex + 1} of {matchCount}</span>
      <button className="tool" aria-label="Previous match" title="Previous match" disabled={!matchCount} onClick={() => editor && stepFind(editor, -1)}><ArrowUp size={16} /></button>
      <button className="tool" aria-label="Next match" title="Next match" disabled={!matchCount} onClick={() => editor && stepFind(editor, 1)}><ArrowDown size={16} /></button>
      <button className="tool" aria-label="Close find" title="Close find" onClick={dismissFind}><X size={16} /></button>
    </div>}
    <NoteTitle inputRef={titleInput} value={title} readOnly={!ready || locked} find={state?.find} onChange={changeTitle} onEnter={() => { if (editor?.isEditable) editor.commands.focus("start"); }} onBlur={() => { void coordinator.current?.flush().catch(() => undefined); }} onComposition={composing => coordinator.current?.setComposing(composing)} />
    <input ref={imageFileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple aria-label="Choose images" onChange={event => { void importImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    <section className="note-body">
      {error && <div className="save-error" role="alert">{error}<div className="error-actions"><button onClick={() => void retry()}>Retry</button><button onClick={() => void copyDraft()}>{loadError ? "Copy available text" : "Copy draft"}</button></div></div>}
      {loadError && note?.plainText ? <pre className="recovery-text">{note.plainText}</pre> : <EditorContent editor={editor} />}
    </section>
    <footer className="note-footer" data-tauri-drag-region onMouseDown={startWindowDrag}><span className="visually-hidden" role="status" aria-live="polite">{saveStatus === "loading" ? "Loading note" : saveStatus === "saving" ? "Saving note" : saveStatus === "error" ? "Couldn't save note" : "Note saved"}</span><div className="reading-controls"><button aria-label="Decrease text size" title="Decrease text size" disabled={fontSize === 12} onClick={() => changeReadingSize(-1)}><AArrowDown size={16} /></button><button aria-label="Increase text size" title="Increase text size" disabled={fontSize === 24} onClick={() => changeReadingSize(1)}><AArrowUp size={16} /></button></div></footer>
  </main>;
}
