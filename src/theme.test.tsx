// @vitest-environment jsdom
import type { PropsWithChildren } from "react";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, listen } from "@tauri-apps/api/event";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { ThemeMenuItems, ThemePicker } from "./ThemePicker";
import { initializeTheme, THEME_EVENT, THEME_STORAGE_KEY, ThemeProvider, useTheme } from "./theme";
import type { ThemePreference } from "./theme";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => vi.fn()),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function Provider({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

let systemDark: boolean;
let mediaListeners: Set<(event: MediaQueryListEvent) => void>;
let registrations: { receive: EventCallback<unknown>; dispose: ReturnType<typeof vi.fn> }[];

function changeSystem(matches: boolean) {
  systemDark = matches;
  act(() => {
    for (const listener of mediaListeners) listener({ matches } as MediaQueryListEvent);
  });
}

function receiveTheme(payload: unknown) {
  act(() => {
    registrations[registrations.length - 1].receive({ event: THEME_EVENT, id: 1, payload });
  });
}

function storageChange(newValue: string | null, key: string | null = THEME_STORAGE_KEY, storageArea = window.localStorage) {
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea })); });
}

function expectTheme(preference: ThemePreference, resolvedTheme: "warm" | "night") {
  expect(document.documentElement.dataset.themePreference).toBe(preference);
  expect(document.documentElement.dataset.theme).toBe(resolvedTheme);
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  systemDark = false;
  mediaListeners = new Set();
  registrations = [];
  const media = {
    get matches() { return systemDark; },
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { mediaListeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { mediaListeners.delete(listener); }),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  vi.mocked(emit).mockReset().mockResolvedValue(undefined);
  vi.mocked(listen).mockReset().mockImplementation(async (_event, receive) => {
    const dispose = vi.fn();
    registrations.push({ receive, dispose });
    return dispose;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme bootstrap and persistence", () => {
  it("defaults to Warm before React renders even when the OS uses dark mode", () => {
    systemDark = true;
    initializeTheme();
    expectTheme("warm", "warm");
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    expect(result.current.preference).toBe("warm");
    expect(result.current.resolvedTheme).toBe("warm");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(listen).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each<ThemePreference>(["warm", "night", "system"])("applies saved %s before rendering and keeps the provider consistent", preference => {
    systemDark = true;
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    initializeTheme();
    expectTheme(preference, preference === "warm" ? "warm" : "night");
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    expect(result.current.preference).toBe(preference);
    expect(result.current.resolvedTheme).toBe(document.documentElement.dataset.theme);
  });

  it.each(["", "dark", "Warm", "system ", '"night"', '{"preference":"night"}', "null"])("falls back to Warm for invalid saved data %j", value => {
    systemDark = true;
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
    initializeTheme();
    expectTheme("warm", "warm");
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    expect(result.current.preference).toBe("warm");
    expectTheme("warm", "warm");
  });

  it("persists a choice and restores it after a window remount", () => {
    const first = renderHook(() => useTheme(), { wrapper: Provider });
    act(() => { first.result.current.setPreference("night"); });
    expectTheme("night", "night");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("night");
    first.unmount();
    initializeTheme();
    expectTheme("night", "night");
    const second = renderHook(() => useTheme(), { wrapper: Provider });
    expect(second.result.current.preference).toBe("night");
    expect(emit).not.toHaveBeenCalled();
  });

  it("falls back safely when the localStorage getter is blocked and still allows choices", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    initializeTheme();
    expectTheme("warm", "warm");
    const { result } = renderHook(() => useTheme(), { wrapper: Provider, reactStrictMode: true });
    act(() => { result.current.setPreference("night"); });
    expectTheme("night", "night");
    act(() => { result.current.setPreference("system"); });
    changeSystem(true);
    expectTheme("system", "night");
  });

  it("handles a failing storage read without losing in-memory state", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
    initializeTheme();
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    expectTheme("warm", "warm");
    act(() => { result.current.setPreference("night"); });
    expect(result.current.preference).toBe("night");
    expectTheme("night", "night");
  });

  it("still applies and broadcasts choices when persistence fails", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    await act(async () => { await Promise.resolve(); });
    act(() => { result.current.setPreference("night"); });
    expectTheme("night", "night");
    expect(emit).toHaveBeenCalledExactlyOnceWith(THEME_EVENT, "night");
  });

  it("rejects invalid runtime choices without changing or persisting the theme", () => {
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    act(() => { result.current.setPreference("dark" as ThemePreference); });
    expect(result.current.preference).toBe("warm");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expectTheme("warm", "warm");
  });
});

describe("System appearance", () => {
  it("follows OS changes only while System is selected and persists the preference", () => {
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    act(() => { result.current.setPreference("system"); });
    expectTheme("system", "warm");
    changeSystem(true);
    expect(result.current.resolvedTheme).toBe("night");
    expectTheme("system", "night");
    changeSystem(false);
    expectTheme("system", "warm");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    act(() => { result.current.setPreference("warm"); });
    changeSystem(true);
    expectTheme("warm", "warm");
    act(() => { result.current.setPreference("night"); });
    changeSystem(false);
    expectTheme("night", "night");
    act(() => { result.current.setPreference("system"); });
    expectTheme("system", "warm");
  });

  it("uses Warm for System if matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    initializeTheme();
    expectTheme("system", "warm");
    const { result, unmount } = renderHook(() => useTheme(), { wrapper: Provider });
    expect(result.current.resolvedTheme).toBe("warm");
    act(() => { result.current.setPreference("night"); });
    expectTheme("night", "night");
    unmount();
  });
});

describe("cross-window synchronization", () => {
  it("receives storage choices, removals, invalid data, and clear without rebroadcasting", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    await act(async () => { await Promise.resolve(); });
    storageChange("night");
    expect(result.current.preference).toBe("night");
    expectTheme("night", "night");
    storageChange("system");
    changeSystem(true);
    expectTheme("system", "night");
    storageChange("invalid");
    expectTheme("warm", "warm");
    storageChange("night");
    storageChange(null);
    expectTheme("warm", "warm");
    storageChange("night");
    storageChange(null, null);
    expectTheme("warm", "warm");
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores storage changes for unrelated keys and session storage", () => {
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    storageChange("night", "other.setting");
    storageChange("night", THEME_STORAGE_KEY, window.sessionStorage);
    storageChange(null, null, window.sessionStorage);
    expect(result.current.preference).toBe("warm");
    expectTheme("warm", "warm");
  });

  it("broadcasts one local choice and persists remote choices without an event loop", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    await act(async () => { await Promise.resolve(); });
    expect(listen).toHaveBeenCalledExactlyOnceWith(THEME_EVENT, expect.any(Function));
    expect(emit).not.toHaveBeenCalled();
    act(() => { result.current.setPreference("night"); });
    expect(emit).toHaveBeenCalledExactlyOnceWith(THEME_EVENT, "night");
    receiveTheme("night");
    act(() => { result.current.setPreference("night"); });
    expect(emit).toHaveBeenCalledTimes(1);
    receiveTheme("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expectTheme("system", "warm");
    changeSystem(true);
    expectTheme("system", "night");
    receiveTheme("warm");
    expect(result.current.preference).toBe("warm");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("warm");
    expectTheme("warm", "warm");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed native payloads instead of changing a valid preference", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    window.localStorage.setItem(THEME_STORAGE_KEY, "night");
    renderHook(() => useTheme(), { wrapper: Provider });
    await act(async () => { await Promise.resolve(); });
    for (const payload of [null, undefined, "dark", "Night", {}, { preference: "warm" }]) receiveTheme(payload);
    expectTheme("night", "night");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("night");
    expect(emit).not.toHaveBeenCalled();
  });

  it("receives native updates with blocked storage and keeps the choice when registration finishes", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Blocked"); });
    const pending = deferred<UnlistenFn>();
    vi.mocked(listen).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    const receive = vi.mocked(listen).mock.calls[0][1];
    act(() => { receive({ event: THEME_EVENT, id: 1, payload: "night" }); });
    await act(async () => { pending.resolve(vi.fn()); });
    expect(result.current.preference).toBe("night");
    expectTheme("night", "night");
    expect(emit).not.toHaveBeenCalled();
  });

  it("catches a saved update missed while native registration was pending", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const pending = deferred<UnlistenFn>();
    vi.mocked(listen).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    window.localStorage.setItem(THEME_STORAGE_KEY, "night");
    await act(async () => { pending.resolve(vi.fn()); });
    expect(result.current.preference).toBe("night");
    expectTheme("night", "night");
  });

  it("keeps a local choice when registration finishes after a failed storage write", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const pending = deferred<UnlistenFn>();
    vi.mocked(listen).mockReturnValueOnce(pending.promise);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    act(() => { result.current.setPreference("night"); });
    await act(async () => { pending.resolve(vi.fn()); });
    expect(result.current.preference).toBe("night");
    expectTheme("night", "night");
  });

  it("continues with storage and OS updates if native listen or emit fails", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.mocked(listen).mockRejectedValueOnce(new Error("Events unavailable"));
    vi.mocked(emit).mockRejectedValueOnce(new Error("Events unavailable"));
    const { result } = renderHook(() => useTheme(), { wrapper: Provider });
    await act(async () => { result.current.setPreference("night"); });
    expectTheme("night", "night");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("night");
    storageChange("system");
    changeSystem(true);
    expectTheme("system", "night");
  });
});

describe("listener lifecycle", () => {
  it("cleans up storage, system, and registered native listeners on unmount", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useTheme(), { wrapper: Provider });
    await act(async () => { await Promise.resolve(); });
    const storageListener = added.mock.calls.find(([type]) => type === "storage")?.[1];
    expect(storageListener).toBeDefined();
    expect(mediaListeners.size).toBe(1);
    unmount();
    expect(removed).toHaveBeenCalledWith("storage", storageListener);
    expect(mediaListeners.size).toBe(0);
    expect(registrations[0].dispose).toHaveBeenCalledOnce();
    receiveTheme("night");
    expectTheme("warm", "warm");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("disposes late native registrations and ignores callbacks after unmount", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const pending = deferred<UnlistenFn>();
    const dispose = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => useTheme(), { wrapper: Provider });
    const receive = vi.mocked(listen).mock.calls[0][1];
    unmount();
    act(() => { receive({ event: THEME_EVENT, id: 1, payload: "night" }); });
    await act(async () => { pending.resolve(dispose); });
    expect(dispose).toHaveBeenCalledOnce();
    expect(mediaListeners.size).toBe(0);
    expectTheme("warm", "warm");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("survives StrictMode replay with one active listener and one broadcast per choice", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const first = deferred<UnlistenFn>();
    const firstDispose = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(first.promise);
    const { result, unmount } = renderHook(() => useTheme(), { wrapper: Provider, reactStrictMode: true });
    expect(listen).toHaveBeenCalledTimes(2);
    expect(mediaListeners.size).toBe(1);
    const cancelledReceive = vi.mocked(listen).mock.calls[0][1];
    const activeReceive = vi.mocked(listen).mock.calls[1][1];
    await act(async () => { first.resolve(firstDispose); });
    expect(firstDispose).toHaveBeenCalledOnce();
    act(() => { cancelledReceive({ event: THEME_EVENT, id: 1, payload: "night" }); });
    expectTheme("warm", "warm");
    act(() => { activeReceive({ event: THEME_EVENT, id: 1, payload: "night" }); });
    expectTheme("night", "night");
    const persist = vi.spyOn(Storage.prototype, "setItem");
    act(() => { result.current.setPreference("warm"); });
    expectTheme("warm", "warm");
    expect(emit).toHaveBeenCalledExactlyOnceWith(THEME_EVENT, "warm");
    expect(persist).toHaveBeenCalledExactlyOnceWith(THEME_STORAGE_KEY, "warm");
    unmount();
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(mediaListeners.size).toBe(0);
    expect(registrations[0].dispose).toHaveBeenCalledOnce();
  });
});

describe("appearance controls", () => {
  it("shares native radio and menu radio state with accessible names", () => {
    const { getByRole, getAllByRole } = render(<ThemeProvider>
      <ThemePicker />
      <div role="menu" aria-label="Note appearance"><ThemeMenuItems /></div>
    </ThemeProvider>);
    expect(getByRole("group", { name: "Appearance" }).tagName).toBe("FIELDSET");
    expect(getAllByRole("radio")).toHaveLength(3);
    expect(getAllByRole("menuitemradio")).toHaveLength(3);
    expect((getByRole("radio", { name: "Warm" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(getByRole("radio", { name: "Night" }));
    expect(getByRole("menuitemradio", { name: "Night" }).getAttribute("aria-checked")).toBe("true");
    expect(getByRole("menuitemradio", { name: "Warm" }).getAttribute("aria-checked")).toBe("false");
    expectTheme("night", "night");
    fireEvent.click(getByRole("menuitemradio", { name: "System" }));
    expect((getByRole("radio", { name: "System" }) as HTMLInputElement).checked).toBe(true);
    expect(getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    expectTheme("system", "warm");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("uses distinct radio group names for multiple picker instances", () => {
    const { getAllByRole } = render(<ThemeProvider><ThemePicker /><ThemePicker /></ThemeProvider>);
    const warmInputs = getAllByRole("radio", { name: "Warm" }) as HTMLInputElement[];
    expect(warmInputs[0].name).not.toBe(warmInputs[1].name);
    fireEvent.click(getAllByRole("radio", { name: "Night" })[0]);
    for (const radio of getAllByRole("radio", { name: "Night" }) as HTMLInputElement[]) expect(radio.checked).toBe(true);
  });
});
