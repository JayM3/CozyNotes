import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { factoryNoteDefaults } from "./noteDefaults";
import { notesApi } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("settings and batch IPC", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("uses the reviewed settings command names and payloads", async () => {
    const settings = { runInBackground: true, rememberDesk: true, openOnStartup: false, trayAvailable: true, warning: null };
    vi.mocked(invoke).mockResolvedValue(settings);
    await expect(notesApi.getSettings()).resolves.toEqual(settings);
    expect(invoke).toHaveBeenNthCalledWith(1, "get_settings", {});
    await expect(notesApi.setRunInBackground(false)).resolves.toEqual(settings);
    expect(invoke).toHaveBeenNthCalledWith(2, "set_run_in_background", { enabled: false });
    await expect(notesApi.setOpenOnStartup(true)).resolves.toEqual(settings);
    expect(invoke).toHaveBeenNthCalledWith(3, "set_open_on_startup", { enabled: true });
  });

  it("saves the complete note defaults with a focused response", async () => {
    const defaults = { ...factoryNoteDefaults, width: 400, height: 500 };
    vi.mocked(invoke).mockResolvedValue(defaults);
    await expect(notesApi.setNoteDefaults(defaults)).resolves.toEqual(defaults);
    expect(invoke).toHaveBeenCalledWith("set_note_defaults", { defaults });
  });

  it("reads the native window capability contract", async () => {
    const capabilities = { absoluteWindowPosition: true, alwaysOnTop: true };
    vi.mocked(invoke).mockResolvedValue(capabilities);
    await expect(notesApi.getPlatformCapabilities()).resolves.toEqual(capabilities);
    expect(invoke).toHaveBeenCalledWith("platform_capabilities", {});
  });

  it("sends explicit selections through the atomic batch commands", async () => {
    await notesApi.trashMany(["one", "two"]);
    expect(invoke).toHaveBeenNthCalledWith(1, "trash_notes", { ids: ["one", "two"] });
    await notesApi.purgeMany(["two"]);
    expect(invoke).toHaveBeenNthCalledWith(2, "purge_notes", { ids: ["two"] });
  });

  it("consumes a native error with the library-only queued-error command", async () => {
    vi.mocked(invoke).mockResolvedValue("Your drafts remain open.");
    await expect(notesApi.takeAppError()).resolves.toBe("Your drafts remain open.");
    expect(invoke).toHaveBeenCalledWith("take_app_error", {});
  });
});
