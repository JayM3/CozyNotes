// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { clearFind, FindExtension, getFindState, hasCompletedTasks, resetCompletedTasks, setFindQuery, setFindTitle, stepFind } from "./editorTools";

const editors: Editor[] = [];

function makeEditor(content: JSONContent | string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), FindExtension],
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("FindExtension", () => {
  it("searches the title before the body, wraps between both, and never changes the document", () => {
    const editor = makeEditor("<p>Pack a bag</p>");
    const original = editor.getJSON();
    const updates = vi.fn();
    editor.on("update", updates);
    setFindTitle(editor, "Pack for the weekend");
    expect(setFindQuery(editor, "pack").matches).toEqual([{ from: 0, to: 4, inTitle: true }, { from: 1, to: 5 }]);
    expect(editor.view.dom.querySelector('[data-find-active="true"]')).toBeNull();
    expect(stepFind(editor, 1)).toEqual({ from: 1, to: 5 });
    expect(editor.view.dom.querySelector('[data-find-active="true"]')?.textContent).toBe("Pack");
    expect(stepFind(editor, 1)).toEqual({ from: 0, to: 4, inTitle: true });
    setFindTitle(editor, "Weekend");
    expect(getFindState(editor).matches).toEqual([{ from: 1, to: 5 }]);
    expect(getFindState(editor).activeIndex).toBe(0);
    expect(editor.getJSON()).toEqual(original);
    expect(updates).not.toHaveBeenCalled();
    expect(undoDepth(editor.state)).toBe(0);
  });

  it("keeps an active body match when title matches are added and supports Unicode in titles", () => {
    const editor = makeEditor("<p>Straße</p>");
    setFindQuery(editor, "STRASSE");
    setFindTitle(editor, "Straße Café");
    expect(getFindState(editor).activeIndex).toBe(1);
    expect(stepFind(editor, -1)).toEqual({ from: 0, to: 6, inTitle: true });
    expect(setFindQuery(editor, "CAFE\u0301").matches).toEqual([{ from: 7, to: 11, inTitle: true }]);
    clearFind(editor);
    expect(getFindState(editor).matches).toEqual([]);
  });
  it("finds across formatting while treating paragraphs and hard breaks as boundaries", () => {
    const editor = makeEditor("<p>Hel<strong>lo</strong> hello</p><p>hel<br>lo</p><p>hel</p><p>lo</p>");
    expect(setFindQuery(editor, "HELLO")).toEqual({ query: "HELLO", matches: [{ from: 1, to: 6 }, { from: 7, to: 12 }], activeIndex: 0 });
    expect(editor.view.dom.querySelectorAll(".find-match").length).toBeGreaterThanOrEqual(2);
    expect(editor.view.dom.querySelector('[data-find-active="true"]')?.textContent).toBe("Hel");
    expect(setFindQuery(editor, "hel\nlo").matches).toEqual([]);
  });

  it("uses canonical full folding and original positions for emoji and expansions", () => {
    const editor = makeEditor("<p>Stra\u00dfe <strong>CAFE</strong>\u0301 \ud83d\ude00</p>");
    expect(setFindQuery(editor, "STRASSE").matches).toEqual([{ from: 1, to: 7 }]);
    expect(setFindQuery(editor, "caf\u00e9").matches).toEqual([{ from: 8, to: 13 }]);
    expect(setFindQuery(editor, "\ud83d\ude00").matches).toEqual([{ from: 14, to: 16 }]);
  });

  it("navigates with wrapping and clears without modifying selection, content, dirty events, or history", () => {
    const editor = makeEditor("<p>a.b a.b</p>");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    const selection = editor.state.selection.toJSON();
    const document = editor.getJSON();
    const updates = vi.fn();
    editor.on("update", updates);
    const history = { undo: undoDepth(editor.state), redo: redoDepth(editor.state) };

    setFindQuery(editor, "a.b");
    expect(stepFind(editor, 1)).toEqual({ from: 5, to: 8 });
    expect(stepFind(editor, 1)).toEqual({ from: 1, to: 4 });
    expect(stepFind(editor, -1)).toEqual({ from: 5, to: 8 });
    expect(editor.state.selection.toJSON()).toEqual(selection);
    clearFind(editor);

    expect(getFindState(editor)).toEqual({ query: "", matches: [], activeIndex: -1 });
    expect(editor.view.dom.querySelector(".find-match")).toBeNull();
    expect(editor.getJSON()).toEqual(document);
    expect(updates).not.toHaveBeenCalled();
    expect({ undo: undoDepth(editor.state), redo: redoDepth(editor.state) }).toEqual(history);
    expect(stepFind(editor, 1)).toBeNull();
  });

  it("updates ranges during edits and preserves the active result where possible", () => {
    const editor = makeEditor("<p>note note</p>");
    setFindQuery(editor, "note");
    stepFind(editor, 1);
    editor.commands.insertContentAt(1, "a ");
    expect(getFindState(editor)).toEqual({ query: "note", matches: [{ from: 3, to: 7 }, { from: 8, to: 12 }], activeIndex: 1 });
    editor.commands.deleteRange({ from: 8, to: 12 });
    expect(getFindState(editor)).toEqual({ query: "note", matches: [{ from: 3, to: 7 }], activeIndex: 0 });
    editor.commands.deleteRange({ from: 3, to: 7 });
    expect(getFindState(editor).activeIndex).toBe(-1);
  });

  it("does not dispatch when setting an unchanged query", () => {
    const editor = makeEditor("<p>note</p>");
    const transactions = vi.fn();
    editor.on("transaction", transactions);
    clearFind(editor);
    expect(transactions).not.toHaveBeenCalled();
    setFindQuery(editor, "note");
    transactions.mockClear();
    setFindQuery(editor, "note");
    expect(transactions).not.toHaveBeenCalled();
  });
});

describe("resetCompletedTasks", () => {
  it("resets checked nested tasks in one undoable document transaction and preserves everything else", () => {
    const editor = makeEditor({ type: "doc", content: [{ type: "taskList", content: [
      { type: "taskItem", attrs: { checked: true }, content: [
        { type: "paragraph", content: [{ type: "text", text: "Pack ", marks: [{ type: "bold" }] }, { type: "text", text: "bag" }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Passport" }] }] }] },
      ] },
      { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Tickets" }] }] },
    ] }, { type: "paragraph", content: [{ type: "text", text: "Keep this note" }] }] });
    const original = editor.getJSON();
    const expected = structuredClone(original);
    const uncheck = (node: JSONContent) => {
      if (node.type === "taskItem") node.attrs = { ...node.attrs, checked: false };
      node.content?.forEach(uncheck);
    };
    uncheck(expected);
    const updates = vi.fn();
    editor.on("update", updates);

    expect(hasCompletedTasks(editor)).toBe(true);
    expect(resetCompletedTasks(editor)).toBe(true);
    expect(editor.getJSON()).toEqual(expected);
    expect(hasCompletedTasks(editor)).toBe(false);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(undoDepth(editor.state)).toBe(1);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(original);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(expected);
  });

  it("is a clean no-op when tasks are absent or all are unchecked", () => {
    for (const content of ["<p>Just text</p>", '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Pending</p></li></ul>']) {
      const editor = makeEditor(content);
      const transactions = vi.fn();
      const updates = vi.fn();
      editor.on("transaction", transactions);
      editor.on("update", updates);
      expect(hasCompletedTasks(editor)).toBe(false);
      expect(resetCompletedTasks(editor)).toBe(false);
      expect(transactions).not.toHaveBeenCalled();
      expect(updates).not.toHaveBeenCalled();
      expect(undoDepth(editor.state)).toBe(0);
    }
  });

  it("keeps adjacent typing separate from the reset undo step", () => {
    const editor = makeEditor('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Pack</p></li></ul>');
    editor.commands.insertContentAt(3, "A ");
    const beforeReset = editor.getJSON();
    resetCompletedTasks(editor);
    const afterReset = editor.getJSON();
    editor.commands.insertContentAt(3, "B ");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(afterReset);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(beforeReset);
  });
});
