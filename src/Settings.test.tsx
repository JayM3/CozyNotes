// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { ThemeProvider } from "./theme";
import { useAppUpdates } from "./useAppUpdates";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), setNoteDefaults: vi.fn(), setRunInBackground: vi.fn(), setRememberDesk: vi.fn(), setOpenOnStartup: vi.fn(), check: vi.fn(), relaunch: vi.fn() }));
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), notesApi: { setNoteDefaults: mocks.setNoteDefaults, getSettings: mocks.getSettings, setRunInBackground: mocks.setRunInBackground, setRememberDesk: mocks.setRememberDesk, setOpenOnStartup: mocks.setOpenOnStartup } }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

function renderSettings() {
  function SettingsWithUpdates() {
    const updates = useAppUpdates();
    return <Settings updates={updates} />;
  }
  return render(<ThemeProvider><SettingsWithUpdates /></ThemeProvider>);
}

describe("Settings", () => {
  beforeEach(() => {
    mocks.getSettings.mockReset().mockResolvedValue({ runInBackground: true, rememberDesk: true, openOnStartup: false, trayAvailable: true, warning: null });
    mocks.setRunInBackground.mockReset().mockResolvedValue({ runInBackground: false, rememberDesk: true, openOnStartup: false, trayAvailable: true, warning: null });
    mocks.setOpenOnStartup.mockReset().mockResolvedValue({ runInBackground: true, rememberDesk: true, openOnStartup: true, trayAvailable: true, warning: null });
    mocks.check.mockReset().mockResolvedValue(null);
    mocks.relaunch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("preserves Remember my desk after a failed save and allows retry", async () => {
    mocks.setRememberDesk.mockReset().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue({ rememberDesk: false, runInBackground: true, openOnStartup: false, trayAvailable: true, warning: null });
    renderSettings();
    const toggle=await screen.findByRole("switch", { name: "Remember my desk" });
    fireEvent.click(toggle);
    await screen.findByRole("alert");
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  });

  it("enables Open on startup and keeps the value unchanged when saving fails", async () => {
    mocks.setOpenOnStartup.mockRejectedValueOnce(new Error("Startup registration failed"));
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Open on startup" });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    expect(mocks.setOpenOnStartup).toHaveBeenNthCalledWith(1, true);
    expect(mocks.setOpenOnStartup).toHaveBeenNthCalledWith(2, true);
  });

  it("keeps the previous switch value when saving fails and allows a retry", async () => {
    mocks.setRunInBackground.mockRejectedValueOnce("Settings could not be persisted; the previous effective preference remains active");
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Run in background" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Run in background" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Run in background" }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Run in background" }) as HTMLInputElement).checked).toBe(false));
    expect(mocks.setRunInBackground).toHaveBeenNthCalledWith(1, false);
    expect(mocks.setRunInBackground).toHaveBeenNthCalledWith(2, false);
  });

  it("disables background mode with the native warning when no tray is available", async () => {
    mocks.getSettings.mockResolvedValueOnce({ runInBackground: false, rememberDesk: true, openOnStartup: false, trayAvailable: false, warning: "The system tray is unavailable." });
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Run in background" });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("The system tray is unavailable.")).toBeTruthy();
    expect(mocks.setRunInBackground).not.toHaveBeenCalled();
  });

  it("offers retry after settings cannot be loaded", async () => {
    mocks.getSettings.mockRejectedValueOnce("settings unavailable");
    renderSettings();
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("switch", { name: "Run in background" })).toBeTruthy();
  });

  it("reports when no update is available", async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You're using the latest version.")).toBeTruthy();
  });

  it("offers the available release and installs it", async () => {
    const update = { version: "0.3.0", downloadAndInstall: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    mocks.check.mockResolvedValueOnce(update);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    const install = await screen.findByRole("button", { name: "Update to 0.3.0" });
    fireEvent.click(install);
    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledWith(undefined, { restartAfterInstall: true }));
    expect(mocks.relaunch).toHaveBeenCalled();
  });

  it("keeps the install button available after a download fails", async () => {
    const update = { version: "0.3.0", downloadAndInstall: vi.fn().mockRejectedValueOnce(new Error("Download interrupted")).mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    mocks.check.mockResolvedValueOnce(update);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update to 0.3.0" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't install the update. Download interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Update to 0.3.0" }));
    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledTimes(2));
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
});
