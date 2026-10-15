import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveCoordinator } from "./saveCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("serialized saves", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(save = vi.fn(async (_document: string, revision: number) => ({ revision: revision + 1 }))) {
    const onSaved = vi.fn();
    const onStatus = vi.fn();
    const coordinator = new SaveCoordinator({ revision: 7, save, onSaved, onStatus });
    return { coordinator, save, onSaved, onStatus };
  }

  it("does not save a hydrated note and debounces real changes", async () => {
    const { coordinator, save } = setup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    coordinator.markDirty("one");
    await vi.advanceTimersByTimeAsync(200);
    coordinator.markDirty("two");
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("two", 7);
    expect(coordinator.dirty).toBe(false);
  });

  it("commits during continuous typing by two seconds", async () => {
    const { coordinator, save } = setup();
    for (let i = 0; i < 10; i++) {
      coordinator.markDirty(String(i));
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(save).toHaveBeenCalledExactlyOnceWith("9", 7);
  });

  it("keeps newer edits dirty until the next serialized acknowledgment", async () => {
    const first = deferred<{ revision: number }>();
    const second = deferred<{ revision: number }>();
    const save = vi.fn<(_document: string, revision: number) => Promise<{ revision: number }>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { coordinator, onStatus } = setup(save);
    coordinator.markDirty("old");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.markDirty("final");
    const flushA = coordinator.flush();
    const flushB = coordinator.flush();
    first.resolve({ revision: 8 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).not.toHaveBeenCalledWith("saved");
    expect(save).toHaveBeenNthCalledWith(2, "final", 8);
    expect(save).toHaveBeenCalledTimes(2);
    second.resolve({ revision: 9 });
    await Promise.all([flushA, flushB]);
    expect(coordinator.dirty).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith("saved");
  });

  it("retains failed drafts for an explicit retry", async () => {
    const save = vi.fn(async (_document: string, revision: number) => ({ revision: revision + 1 }))
      .mockRejectedValueOnce(new Error("disk full"));
    const { coordinator, onStatus } = setup(save);
    coordinator.markDirty("keep me");
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.dirty).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith("error", expect.any(Error));
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    await coordinator.flush();
    expect(save).toHaveBeenLastCalledWith("keep me", 7);
    expect(coordinator.dirty).toBe(false);
  });

  it("waits for composition before flushing the completed document", async () => {
    const { coordinator, save } = setup();
    coordinator.setComposing(true);
    coordinator.markDirty("partial");
    const flush = coordinator.flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).not.toHaveBeenCalled();
    coordinator.markDirty("\u65e5\u672c\u8a9e");
    coordinator.setComposing(false);
    await flush;
    expect(save).toHaveBeenCalledExactlyOnceWith("\u65e5\u672c\u8a9e", 7);
  });

  it("cancels timers and ignores callbacks after disposal", async () => {
    const { coordinator, save, onStatus } = setup();
    coordinator.markDirty("draft");
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("rechecks composition when an earlier save completes during a flush", async () => {
    const first = deferred<{ revision: number }>();
    const save = vi.fn(async (_document: string, revision: number) => ({ revision: revision + 1 })).mockReturnValueOnce(first.promise);
    const { coordinator } = setup(save);
    coordinator.markDirty("before");
    await vi.advanceTimersByTimeAsync(300);
    const flush = coordinator.flush();
    coordinator.setComposing(true);
    coordinator.markDirty("partial");
    first.resolve({ revision: 8 });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
    coordinator.markDirty("completed");
    coordinator.setComposing(false);
    await flush;
    expect(save).toHaveBeenLastCalledWith("completed", 8);
  });
});
