// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notesApi } from "./api";
import { useLibrarySearch } from "./useLibrarySearch";
import type { NoteSummary, View } from "./api";
import { listen } from "@tauri-apps/api/event";

vi.mock("./api", () => ({ notesApi: { list: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const summary = (title: string): NoteSummary => ({ id: title, title, preview: title, snippet: [], color: "cream", revision: 1, updatedAt: 0 });

describe("library search requests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(notesApi.list).mockReset();
    vi.mocked(notesApi.list).mockResolvedValue([]);
    vi.mocked(listen).mockClear();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("debounces queries and ignores out-of-order results", async () => {
    const old = deferred<NoteSummary[]>();
    const newest = deferred<NoteSummary[]>();
    vi.mocked(notesApi.list).mockReturnValueOnce(old.promise).mockReturnValueOnce(newest.promise);
    const { result, rerender } = renderHook(({ query }) => useLibrarySearch("notes", query, null), { initialProps: { query: "old" } });
    await act(() => vi.advanceTimersByTimeAsync(150));
    rerender({ query: "new" });
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(notesApi.list).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => { newest.resolve([summary("new")]); });
    await act(async () => { old.resolve([summary("old")]); });
    expect(result.current.notes[0].title).toBe("new");
    expect(vi.mocked(listen)).toHaveBeenCalledTimes(7);
  });

  it("invalidates an old view immediately and passes the color filter", async () => {
    const old = deferred<NoteSummary[]>();
    vi.mocked(notesApi.list).mockReturnValueOnce(old.promise).mockResolvedValueOnce([summary("trash")]);
    const { result, rerender } = renderHook(({ view }: { view: View }) => useLibrarySearch(view, "word", "sage"), { initialProps: { view: "notes" as View } });
    await act(() => vi.advanceTimersByTimeAsync(150));
    rerender({ view: "trash" });
    await act(async () => { old.resolve([summary("notes")]); });
    expect(result.current.notes).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(notesApi.list).toHaveBeenLastCalledWith(true, "word", "sage");
    expect(result.current.notes[0].title).toBe("trash");
  });

  it("cleans up event registrations that finish after unmount", async () => {
    const late = deferred<() => void>();
    const dispose = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(late.promise);
    const { unmount } = renderHook(() => useLibrarySearch("notes", "", null));
    unmount();
    await act(async () => { late.resolve(dispose); });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("never displays settled results with another view's actions", async () => {
    vi.mocked(notesApi.list).mockResolvedValueOnce([summary("trashed")]);
    const { result, rerender } = renderHook(({ view }: { view: View }) => useLibrarySearch(view, "", null), { initialProps: { view: "trash" as View } });
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(result.current.notes[0].title).toBe("trashed");
    rerender({ view: "notes" });
    expect(result.current.notes).toEqual([]);
    vi.mocked(notesApi.list).mockRejectedValueOnce(new Error("unavailable"));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(result.current.notes).toEqual([]);
  });
});
