import { Extension, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findTextMatches, type TextMatch } from "./textSearch";

export type FindMatch = TextMatch & { inTitle?: true };
export type FindState = { query: string; matches: FindMatch[]; activeIndex: number };

type FindAction = { type: "query"; query: string } | { type: "step"; direction: 1 | -1 } | { type: "title"; title: string };
type FindPluginState = { result: FindState; decorations: DecorationSet; title: string };

const emptyFindState: FindState = { query: "", matches: [], activeIndex: -1 };
const findPluginKey = new PluginKey<FindPluginState>("cozyNoteFind");

function documentMatches(doc: ProseMirrorNode, query: string, title: string): FindMatch[] {
  if (!query) return [];
  const matches: FindMatch[] = findTextMatches(title, query).map(match => ({ ...match, inTitle: true }));

  doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    let text = "";
    let textFrom = position + 1;
    const flush = () => {
      for (const match of findTextMatches(text, query)) {
        matches.push({ from: textFrom + match.from, to: textFrom + match.to });
      }
      text = "";
    };

    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) textFrom = position + 1 + offset;
        text += child.text;
      } else {
        flush();
      }
    });
    flush();
    return false;
  });

  return matches;
}

function decorate(doc: ProseMirrorNode, result: FindState): DecorationSet {
  return DecorationSet.create(doc, result.matches.flatMap((match, index) => match.inTitle ? [] : [Decoration.inline(match.from, match.to, {
    class: index === result.activeIndex ? "find-match find-match-active" : "find-match",
    "data-find-active": String(index === result.activeIndex),
  })]));
}

function nextFindState(transaction: Transaction, previous: FindState, title: string, action?: FindAction): FindState {
  const query = action?.type === "query" ? action.query : previous.query;
  const recompute = transaction.docChanged || query !== previous.query || action?.type === "title";
  const matches = recompute ? documentMatches(transaction.doc, query, title) : previous.matches;
  let activeIndex = previous.activeIndex;

  if (!matches.length) {
    activeIndex = -1;
  } else if (query !== previous.query || activeIndex === -1) {
    activeIndex = 0;
  } else if (recompute) {
    const previousMatch = previous.matches[previous.activeIndex];
    const mappedPosition = previousMatch.inTitle ? previousMatch.from : transaction.mapping.map(previousMatch.from, 1);
    activeIndex = matches.findIndex(match => Boolean(match.inTitle) === Boolean(previousMatch.inTitle) && match.from >= mappedPosition);
    if (activeIndex === -1) activeIndex = 0;
  }

  if (action?.type === "step" && matches.length) {
    activeIndex = (activeIndex + action.direction + matches.length) % matches.length;
  }

  return { query, matches, activeIndex };
}

export const FindExtension = Extension.create({
  name: "cozyNoteFind",

  addProseMirrorPlugins() {
    return [new Plugin<FindPluginState>({
      key: findPluginKey,
      state: {
        init: () => ({ result: emptyFindState, decorations: DecorationSet.empty, title: "" }),
        apply(transaction, previous) {
          const action = transaction.getMeta(findPluginKey) as FindAction | undefined;
          if (!transaction.docChanged && !action) return previous;
          const title = action?.type === "title" ? action.title : previous.title;
          const result = nextFindState(transaction, previous.result, title, action);
          return { result, decorations: decorate(transaction.doc, result), title };
        },
      },
      props: {
        decorations: state => findPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
      },
    })];
  },
});

export function getFindState(editor: Editor | null | undefined): FindState {
  return editor ? findPluginKey.getState(editor.state)?.result ?? emptyFindState : emptyFindState;
}

export function setFindQuery(editor: Editor, query: string): FindState {
  if (query !== getFindState(editor).query) {
    editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { type: "query", query } satisfies FindAction).setMeta("addToHistory", false));
  }
  return getFindState(editor);
}

export function setFindTitle(editor: Editor, title: string): void {
  if (title !== findPluginKey.getState(editor.state)?.title) {
    editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { type: "title", title } satisfies FindAction).setMeta("addToHistory", false));
  }
}

export function stepFind(editor: Editor, direction: 1 | -1): FindMatch | null {
  if (!getFindState(editor).matches.length) return null;
  editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { type: "step", direction } satisfies FindAction).setMeta("addToHistory", false));
  const { matches, activeIndex } = getFindState(editor);
  return matches[activeIndex] ?? null;
}

export function clearFind(editor: Editor): void {
  setFindQuery(editor, "");
}

export function hasCompletedTasks(editor: Editor | null | undefined): boolean {
  if (!editor) return false;
  let completed = false;
  editor.state.doc.descendants(node => {
    if (node.type.name === "taskItem" && node.attrs.checked === true) completed = true;
    return !completed;
  });
  return completed;
}

export function resetCompletedTasks(editor: Editor): boolean {
  const transaction = editor.state.tr;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "taskItem" && node.attrs.checked === true) {
      transaction.setNodeMarkup(position, undefined, { ...node.attrs, checked: false });
    }
  });
  if (!transaction.docChanged) return false;

  editor.view.dispatch(closeHistory(transaction));
  // Keep subsequent typing out of the reset's undo group.
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
  return true;
}
