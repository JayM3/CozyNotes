// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NoteWindow } from "./NoteWindow";
import { ThemeProvider } from "./theme";
import { notesApi } from "./api";
import type { Note } from "./api";

const native = vi.hoisted(() => ({ onCloseRequested: vi.fn(async () => () => {}), close: vi.fn(), isAlwaysOnTop: vi.fn(async () => false) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (value: string) => value }));
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), notesApi: {
  get: vi.fn(), save: vi.fn(), create: vi.fn(), getWindowState: vi.fn(async () => ({ folded: false })),
  getPlatformCapabilities: vi.fn(async () => ({ alwaysOnTop: false })),
} }));

const note: Note = { id: "one", fontFamily: "nunito", fontSize: 20, color: "sage", title: "Title", explicitTitle: "", favorite: false, revision: 0, updatedAt: 1, preview: "", plainText: "", document: { type: "doc", content: [{ type: "paragraph" }] } };
beforeEach(() => {
  vi.mocked(notesApi.get).mockResolvedValue(note);
  vi.mocked(notesApi.save).mockImplementation(async (_id, _revision, draft) => ({ ...note, ...draft, revision: 1 }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("loads the saved base, keeps temporary size through autosave, resets to base, and reopens at base", async () => {
  const view = render(<ThemeProvider><NoteWindow id="one" /></ThemeProvider>);
  const main = screen.getByRole("main");
  await waitFor(() => expect(main.style.getPropertyValue("--reading-size")).toBe("20px"));
  expect(main.style.getPropertyValue("--note-font")).toContain("Nunito");
  fireEvent.keyDown(window, { key: "+", ctrlKey: true });
  expect(main.style.getPropertyValue("--reading-size")).toBe("24px");
  const title = screen.getByRole("textbox", { name: "Note title" });
  await waitFor(() => expect((title as HTMLInputElement).readOnly).toBe(false));
  fireEvent.change(title, { target: { value: "Saved title" } });
  fireEvent.blur(title);
  await waitFor(() => expect(notesApi.save).toHaveBeenCalled());
  expect(main.style.getPropertyValue("--reading-size")).toBe("24px");
  fireEvent.keyDown(window, { key: "0", ctrlKey: true });
  expect(main.style.getPropertyValue("--reading-size")).toBe("20px");
  fireEvent.click(screen.getByRole("button", { name: "Decrease text size" }));
  expect(main.style.getPropertyValue("--reading-size")).toBe("18px");
  view.unmount();
  render(<ThemeProvider><NoteWindow id="one" /></ThemeProvider>);
  await waitFor(() => expect(screen.getByRole("main").style.getPropertyValue("--reading-size")).toBe("20px"));
});
