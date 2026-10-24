// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_INTERVAL_MS, useAppUpdates } from "./useAppUpdates";

const mocks = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

function release(version = "0.3.0") {
  return { version, downloadAndInstall: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("app update checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    mocks.check.mockReset().mockResolvedValue(null);
    mocks.relaunch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("checks on startup and every three hours without downloading", async () => {
    const update = release();
    mocks.check.mockResolvedValueOnce(null).mockResolvedValueOnce(update);
    const { result } = renderHook(() => useAppUpdates());
    await act(async () => {});
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith({ timeout: 15_000 });
    expect(result.current.status).toBe("current");

    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1));
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(result.current.version).toBe("0.3.0");
    expect(result.current.status).toBe("available");
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("starts the next three-hour interval after a manual check", async () => {
    const { result } = renderHook(() => useAppUpdates());
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    await act(() => result.current.checkForUpdates());
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1));
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it.each(["focus", "visibilitychange"])("catches up after sleep on %s without checking on every return", async eventName => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    renderHook(() => useAppUpdates());
    await act(async () => {});
    const target = eventName === "focus" ? window : document;
    await act(async () => { target.dispatchEvent(new Event(eventName)); });
    expect(mocks.check).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL_MS + 1);
    await act(async () => { target.dispatchEvent(new Event(eventName)); });
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await act(async () => { target.dispatchEvent(new Event(eventName)); });
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("silently retries an offline startup when connectivity returns", async () => {
    const update = release();
    mocks.check.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(update);
    const { result } = renderHook(() => useAppUpdates());
    await act(async () => {});
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBe("");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
    });
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(result.current.version).toBe("0.3.0");
  });

  it("keeps a detected release through a failed automatic check and installs it on request", async () => {
    const update = release();
    mocks.check.mockResolvedValueOnce(update).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useAppUpdates());
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS));
    expect(result.current.status).toBe("available");
    expect(result.current.version).toBe("0.3.0");
    expect(result.current.error).toBe("");
    expect(update.close).not.toHaveBeenCalled();
    await act(() => result.current.installUpdate());
    expect(update.downloadAndInstall).toHaveBeenCalledExactlyOnceWith(undefined, { restartAfterInstall: true });
  });

  it("reports manual check failures and allows an immediate retry", async () => {
    mocks.check.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("connection timed out")).mockResolvedValueOnce(release());
    const { result } = renderHook(() => useAppUpdates());
    await act(async () => {});
    await act(() => result.current.checkForUpdates());
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Couldn't check for updates. connection timed out");
    await act(() => result.current.checkForUpdates());
    expect(result.current.status).toBe("available");
    expect(result.current.error).toBe("");
  });

  it("deduplicates Strict Mode startup, manual checks, and wake events while a request is pending", async () => {
    const pending = deferred<ReturnType<typeof release>>();
    mocks.check.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useAppUpdates(), { wrapper: StrictMode });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL_MS);
    await act(async () => {
      void result.current.checkForUpdates();
      window.dispatchEvent(new Event("focus"));
      void result.current.installUpdate();
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    const update = release();
    await act(async () => { pending.resolve(update); });
    expect(result.current.version).toBe(update.version);
    expect(update.close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS));
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("releases superseded update handles and removes the badge state if the release is withdrawn", async () => {
    const first = release();
    const second = release("0.4.0");
    mocks.check.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(null);
    const { result, unmount } = renderHook(() => useAppUpdates());
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS));
    expect(result.current.version).toBe("0.4.0");
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS));
    expect(result.current.status).toBe("current");
    expect(result.current.version).toBe("");
    expect(second.close).toHaveBeenCalledOnce();
    unmount();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("closes an available update and stops scheduled and wake checks on unmount", async () => {
    const update = release();
    mocks.check.mockResolvedValueOnce(update);
    const { unmount } = renderHook(() => useAppUpdates());
    await act(async () => {});
    unmount();
    expect(update.close).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases an update returned after the main window unmounts", async () => {
    const pending = deferred<ReturnType<typeof release>>();
    mocks.check.mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => useAppUpdates());
    unmount();
    const update = release();
    await act(async () => { pending.resolve(update); });
    expect(update.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses checks during installation, preserves the release on failure, and retries installation", async () => {
    const update = release();
    update.downloadAndInstall.mockRejectedValueOnce(new Error("download interrupted"));
    mocks.check.mockResolvedValueOnce(update);
    const { result } = renderHook(() => useAppUpdates());
    await act(async () => {});
    await act(() => result.current.installUpdate());
    expect(result.current.status).toBe("available");
    expect(result.current.version).toBe("0.3.0");
    expect(result.current.error).toBe("Couldn't install the update. download interrupted");

    const installing = deferred<void>();
    update.downloadAndInstall.mockReturnValueOnce(installing.promise);
    act(() => { void result.current.installUpdate(); });
    expect(result.current.status).toBe("installing");
    expect(result.current.error).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2));
    await act(async () => {
      void result.current.checkForUpdates();
      void result.current.installUpdate();
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(update.close).not.toHaveBeenCalled();
    await act(async () => { installing.resolve(); });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    await act(() => result.current.checkForUpdates());
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it("lets the Windows installer handle restarting the app", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
    mocks.check.mockResolvedValueOnce(release());
    const { result } = renderHook(() => useAppUpdates());
    await act(async () => {});
    await act(() => result.current.installUpdate());
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("does not schedule automatic checks in the browser preview", async () => {
    vi.unstubAllGlobals();
    renderHook(() => useAppUpdates());
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2));
    window.dispatchEvent(new Event("focus"));
    expect(mocks.check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
