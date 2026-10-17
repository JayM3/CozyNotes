import { describe, expect, it, vi } from "vitest";
import { EditorOperationCoordinator } from "./editorOperation";

const operation = { operationId: "79ebdd60-9578-480f-a554-ab094d73c9c8", kind: "trash" as const };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function setup() {
  let active = true;
  const options = {
    isActive: vi.fn(async (_id: string) => active),
    waitForIdle: vi.fn(async (): Promise<void> => undefined),
    waitForComposition: vi.fn(async (): Promise<void> => undefined),
    setLocked: vi.fn((_locked: boolean) => undefined),
    flush: vi.fn(async (): Promise<void> => undefined),
    acknowledge: vi.fn(async (_id: string, _success: boolean): Promise<void> => undefined),
    onCommitted: vi.fn(() => undefined),
    onError: vi.fn((_message: string) => undefined),
  };
  return { options, coordinator: new EditorOperationCoordinator(options), deactivate: () => { active = false; } };
}

describe("native editor preparation", () => {
  it("waits for composition and the latest save, then holds the editor until the native operation finishes", async () => {
    const { coordinator, options, deactivate } = setup();
    const composition = deferred();
    const save = deferred();
    options.waitForComposition.mockImplementation(() => composition.promise);
    options.flush.mockImplementation(() => save.promise);
    const preparation = coordinator.prepare(operation);
    await vi.waitFor(() => expect(options.waitForComposition).toHaveBeenCalled());
    expect(options.setLocked).not.toHaveBeenCalled();
    composition.resolve();
    await vi.waitFor(() => expect(options.flush).toHaveBeenCalled());
    expect(options.setLocked).toHaveBeenCalledWith(true);
    expect(options.acknowledge).not.toHaveBeenCalled();
    save.resolve();
    await preparation;
    expect(options.acknowledge).toHaveBeenCalledWith(operation.operationId, true);
    expect(coordinator.busy).toBe(true);
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
    deactivate();
    await coordinator.finish({ operationId: operation.operationId, outcome: "cancelled" });
    expect(coordinator.busy).toBe(false);
    expect(options.setLocked).toHaveBeenLastCalledWith(false);
  });

  it("keeps a committed editor locked until its native window is destroyed", async () => {
    const { coordinator, options, deactivate } = setup();
    await coordinator.prepare(operation);
    deactivate();
    await coordinator.finish({ operationId: operation.operationId, outcome: "committed" });
    expect(coordinator.busy).toBe(true);
    expect(coordinator.canClose).toBe(true);
    expect(options.onCommitted).toHaveBeenCalledTimes(1);
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
    coordinator.dispose();
    expect(coordinator.busy).toBe(false);
  });

  it("can prepare a saved retired editor for exit without saving or unlocking its trashed note", async () => {
    const { coordinator, options, deactivate } = setup();
    await coordinator.prepare(operation);
    deactivate();
    await coordinator.finish({ operationId: operation.operationId, outcome: "committed" });
    const exit = { operationId: "37b7381c-d1cc-477a-b6f4-08db111aa6e7", kind: "exit" as const };
    options.isActive.mockResolvedValue(true);
    options.flush.mockClear();
    await coordinator.prepare(exit);
    expect(options.acknowledge).toHaveBeenLastCalledWith(exit.operationId, true);
    expect(options.flush).not.toHaveBeenCalled();
    expect(coordinator.canClose).toBe(false);
    options.isActive.mockResolvedValue(false);
    await coordinator.finish({ operationId: exit.operationId, outcome: "cancelled" });
    expect(coordinator.canClose).toBe(true);
    expect(coordinator.busy).toBe(true);
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
  });

  it("can retry a failed cancellation check without unlocking an active operation", async () => {
    const { coordinator, options, deactivate } = setup();
    await coordinator.prepare(operation);
    options.isActive.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(coordinator.finish({ operationId: operation.operationId, outcome: "cancelled" })).resolves.toBeUndefined();
    expect(options.onError).toHaveBeenCalledWith(expect.stringContaining("Retry"));
    expect(coordinator.busy).toBe(true);
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
    expect(await coordinator.retryFinish()).toBe(false);
    expect(coordinator.busy).toBe(true);
    deactivate();
    expect(await coordinator.retryFinish()).toBe(true);
    expect(coordinator.busy).toBe(false);
    expect(options.setLocked).toHaveBeenLastCalledWith(false);
  });

  it("keeps a committed draft locked when retrying a failed finish check", async () => {
    const { coordinator, options, deactivate } = setup();
    await coordinator.prepare(operation);
    deactivate();
    options.isActive.mockRejectedValueOnce(new Error("IPC unavailable"));
    await coordinator.finish({ operationId: operation.operationId, outcome: "committed" });
    expect(await coordinator.retryFinish()).toBe(false);
    expect(coordinator.busy).toBe(true);
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
  });

  it("does not resume saving or lock the draft after cancellation while composition is pending", async () => {
    const { coordinator, options, deactivate } = setup();
    const composition = deferred();
    options.waitForComposition.mockImplementation(() => composition.promise);
    const preparation = coordinator.prepare(operation);
    await vi.waitFor(() => expect(options.waitForComposition).toHaveBeenCalled());
    deactivate();
    await coordinator.finish({ operationId: operation.operationId, outcome: "cancelled" });
    options.setLocked.mockClear();
    composition.resolve();
    await preparation;
    expect(options.setLocked).not.toHaveBeenCalled();
    expect(options.flush).not.toHaveBeenCalled();
    expect(options.acknowledge).not.toHaveBeenCalled();
  });

  it("reports a failed save to native code and keeps the draft protected until cancellation", async () => {
    const { coordinator, options, deactivate } = setup();
    options.flush.mockRejectedValue(new Error("disk unavailable"));
    await coordinator.prepare(operation);
    expect(options.acknowledge).toHaveBeenCalledWith(operation.operationId, false);
    expect(options.onError).toHaveBeenCalledWith(expect.stringContaining("draft"));
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
    deactivate();
    await coordinator.finish({ operationId: operation.operationId, outcome: "cancelled" });
    expect(options.setLocked).toHaveBeenLastCalledWith(false);
    expect(coordinator.busy).toBe(false);
  });

  it("ignores duplicate or competing preparations and cannot be unlocked by a stale or premature finish", async () => {
    const { coordinator, options, deactivate } = setup();
    await coordinator.prepare(operation);
    await coordinator.prepare(operation);
    await coordinator.prepare({ operationId: "37b7381c-d1cc-477a-b6f4-08db111aa6e7", kind: "exit" });
    expect(options.flush).toHaveBeenCalledTimes(1);
    expect(options.acknowledge).toHaveBeenCalledTimes(1);
    await coordinator.finish({ operationId: "37b7381c-d1cc-477a-b6f4-08db111aa6e7", outcome: "cancelled" });
    await coordinator.finish({ operationId: operation.operationId, outcome: "cancelled" });
    expect(coordinator.busy).toBe(true);
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
    deactivate();
    await coordinator.finish({ operationId: operation.operationId, outcome: "cancelled" });
    expect(coordinator.busy).toBe(false);
  });

  it("handles failed acknowledgments without an unhandled rejection or releasing a live operation", async () => {
    const { coordinator, options, deactivate } = setup();
    options.acknowledge.mockRejectedValue(new Error("IPC unavailable"));
    await expect(coordinator.prepare(operation)).resolves.toBeUndefined();
    expect(options.onError).toHaveBeenCalled();
    expect(coordinator.busy).toBe(true);
    expect(options.setLocked).not.toHaveBeenCalledWith(false);
    deactivate();
    await coordinator.finish({ operationId: operation.operationId, outcome: "cancelled" });
    expect(coordinator.busy).toBe(false);
  });

  it("reports verification failure without saving and waits for native cancellation", async () => {
    const { coordinator, options } = setup();
    options.isActive.mockRejectedValue(new Error("verification unavailable"));
    await expect(coordinator.prepare(operation)).resolves.toBeUndefined();
    expect(coordinator.busy).toBe(true);
    expect(options.flush).not.toHaveBeenCalled();
    expect(options.acknowledge).toHaveBeenCalledWith(operation.operationId, false);
    expect(options.setLocked).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalled();
  });

  it("does not touch an editor that unmounts while waiting for composition", async () => {
    const { coordinator, options } = setup();
    const composition = deferred();
    options.waitForComposition.mockImplementation(() => composition.promise);
    const preparation = coordinator.prepare(operation);
    await vi.waitFor(() => expect(options.waitForComposition).toHaveBeenCalled());
    coordinator.dispose();
    composition.resolve();
    await preparation;
    expect(options.setLocked).not.toHaveBeenCalled();
    expect(options.flush).not.toHaveBeenCalled();
    expect(options.acknowledge).not.toHaveBeenCalled();
    expect(coordinator.busy).toBe(false);
  });

  it("ignores malformed and expired native requests", async () => {
    const { coordinator, options, deactivate } = setup();
    for (const payload of [null, {}, { operationId: "", kind: "trash" }, { ...operation, kind: "unknown" }]) {
      await coordinator.prepare(payload as typeof operation);
    }
    expect(options.isActive).not.toHaveBeenCalled();
    deactivate();
    await coordinator.prepare(operation);
    expect(coordinator.busy).toBe(false);
    expect(options.setLocked).not.toHaveBeenCalled();
    expect(options.flush).not.toHaveBeenCalled();
    expect(options.acknowledge).not.toHaveBeenCalled();
  });
});
