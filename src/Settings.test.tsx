// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { ThemeProvider } from "./theme";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), setRunInBackground: vi.fn() }));
vi.mock("./api", () => ({ notesApi: { getSettings: mocks.getSettings, setRunInBackground: mocks.setRunInBackground } }));

function renderSettings() {
  return render(<ThemeProvider><Settings /></ThemeProvider>);
}

describe("Settings", () => {
  beforeEach(() => {
    mocks.getSettings.mockReset().mockResolvedValue({ runInBackground: true, trayAvailable: true, warning: null });
    mocks.setRunInBackground.mockReset().mockResolvedValue({ runInBackground: false, trayAvailable: true, warning: null });
  });
  afterEach(() => cleanup());

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
    mocks.getSettings.mockResolvedValueOnce({ runInBackground: false, trayAvailable: false, warning: "The system tray is unavailable." });
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
});
