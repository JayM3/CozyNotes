// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { notesApi } from "./api";
import { useLibrarySearch } from "./useLibrarySearch";
import type { NoteSummary } from "./api";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("./api", () => ({ notesApi: { list: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return vi.fn();
  }),
}));

const summary = (title: string): NoteSummary => ({ id: title, title, preview: title, snippet: [], color: "cream", revision: 1, updatedAt: 0 });

describe("batch library refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.mocked(notesApi.list).mockReset().mockResolvedValue([summary("before")]);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("refreshes once after the consolidated batch-change event", async () => {
    const { result } = renderHook(() => useLibrarySearch("notes", "", null));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(result.current.notes.map(note => note.title)).toEqual(["before"]);
    vi.mocked(notesApi.list).mockResolvedValueOnce([summary("after")]);
    await act(async () => { listeners.get("notes-batch-changed")?.({ payload: { ids: ["before"], action: "trashed" } }); });
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(notesApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.notes.map(note => note.title)).toEqual(["after"]);
    expect(listen).toHaveBeenCalledWith("notes-batch-changed", expect.any(Function));
  });
});
