// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Library } from "./Library";
import { ThemeProvider } from "./theme";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  purge: vi.fn(),
  emptyTrash: vi.fn(),
  trashMany: vi.fn(),
  purgeMany: vi.fn(),
  getSettings: vi.fn(),
  setRunInBackground: vi.fn(),
  takeAppError: vi.fn(),
  events: [] as Array<{ name: string; handler: (event: { payload: unknown }) => void }>,
}));

vi.mock("./api", () => ({
  paperColors: ["cream", "butter", "sage", "rose", "lavender", "mist"],
  notesApi: {
    list: mocks.list,
    create: mocks.create,
    open: mocks.open,
    trash: mocks.trash,
    restore: mocks.restore,
    purge: mocks.purge,
    emptyTrash: mocks.emptyTrash,
    trashMany: mocks.trashMany,
    purgeMany: mocks.purgeMany,
    getSettings: mocks.getSettings,
    setRunInBackground: mocks.setRunInBackground,
    takeAppError: mocks.takeAppError,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.events.push({ name, handler });
    return vi.fn();
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("./windowDrag", () => ({ startWindowDrag: vi.fn() }));

type Summary = { id: string; title: string; preview: string; color: string; revision: number; updatedAt: number; snippet: never[] };
let activeNotes: Summary[];
let trashedNotes: Summary[];
let settings: { runInBackground: boolean; trayAvailable: boolean; warning: string | null };

function note(title: string, color: string = "sage"): Summary {
  return { id: title.toLowerCase().replace(/ /g, "-"), title, preview: `${title} preview`, color, revision: 1, updatedAt: 0, snippet: [] };
}

function renderLibrary() {
  return render(<ThemeProvider><Library /></ThemeProvider>);
}

async function select(name: string) {
  const checkbox = await screen.findByRole("checkbox", { name: `Select ${name}` });
  fireEvent.click(checkbox);
  return checkbox;
}

describe("library settings and selection", () => {
  beforeEach(() => {
    activeNotes = [note("Alpha"), note("Gamma"), note("Beta", "mist"), note("Hidden", "cream")];
    trashedNotes = [note("Old note", "mist"), note("Ancient note", "rose")];
    settings = { runInBackground: true, trayAvailable: true, warning: null };
    mocks.list.mockReset().mockImplementation(async (trash: boolean, query: string, color: string | null) => {
      const source = trash ? trashedNotes : activeNotes;
      const normalized = query.toLocaleLowerCase();
      return source.filter(item => (!normalized || `${item.title} ${item.preview}`.toLocaleLowerCase().includes(normalized)) && (!color || item.color === color));
    });
    mocks.create.mockReset().mockResolvedValue(undefined);
    mocks.open.mockReset().mockResolvedValue(undefined);
    mocks.trash.mockReset().mockResolvedValue(undefined);
    mocks.restore.mockReset().mockResolvedValue(undefined);
    mocks.purge.mockReset().mockResolvedValue(undefined);
    mocks.emptyTrash.mockReset().mockResolvedValue(undefined);
    mocks.trashMany.mockReset().mockResolvedValue(undefined);
    mocks.purgeMany.mockReset().mockImplementation(async (ids: string[]) => { trashedNotes = trashedNotes.filter(item => !ids.includes(item.id)); });
    mocks.getSettings.mockReset().mockImplementation(async () => settings);
    mocks.setRunInBackground.mockReset().mockImplementation(async (enabled: boolean) => { settings = { ...settings, runInBackground: enabled }; return settings; });
    mocks.takeAppError.mockReset().mockResolvedValue(null);
    mocks.events.length = 0;
  });

  afterEach(() => cleanup());

  it("recovers a native error queued before the main window registered its listener", async () => {
    mocks.takeAppError.mockImplementation(async () => {
      expect(mocks.events.some(event => event.name === "app-error")).toBe(true);
      return "Couldn't exit CozyNotes. Your drafts remain open.";
    });
    renderLibrary();
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't exit CozyNotes");
    expect(mocks.takeAppError).toHaveBeenCalledTimes(1);
  });

  it("opens Settings in the content pane and restores separate Notes and Trash filters", async () => {
    renderLibrary();
    const notesSearch = await screen.findByRole("searchbox", { name: "Search notes" });
    fireEvent.change(notesSearch, { target: { value: "Alpha" } });
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sage paper" }));

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    const trashSearch = await screen.findByRole("searchbox", { name: "Search trash" });
    fireEvent.change(trashSearch, { target: { value: "Old" } });
    await waitFor(() => expect(screen.getByText("Old note")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Mist paper" }));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("radio", { name: "Warm" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Night" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "System" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect((screen.getByRole("searchbox", { name: "Search notes" }) as HTMLInputElement).value).toBe("Alpha");
    expect(screen.getByRole("button", { name: "Sage paper" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    expect((screen.getByRole("searchbox", { name: "Search trash" }) as HTMLInputElement).value).toBe("Old");
    expect(screen.getByRole("button", { name: "Mist paper" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("selects a row without opening it and lets the row button open it separately", async () => {
    renderLibrary();
    const checkbox = await select("Alpha");
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(mocks.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("alpha"));
  });

  it("selects only the currently filtered results with the partial-state select-all control", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Alpha" }));
    const selectAll = screen.getByRole("checkbox", { name: "Select all visible notes" });
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");

    fireEvent.click(screen.getByRole("button", { name: "Mist paper" }));
    await screen.findByRole("checkbox", { name: "Select Beta" });
    expect(screen.queryByRole("checkbox", { name: "Select Alpha" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible notes" }));
    expect((screen.getByRole("checkbox", { name: "Select Beta" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Select Hidden" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("1 selected");
  });

  it("clears selection when the query, color, or page changes", async () => {
    renderLibrary();
    await select("Alpha");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes" }), { target: { value: "Gamma" } });
    await screen.findByRole("checkbox", { name: "Select Gamma" });
    expect(screen.queryByRole("status", { name: /selected/ })).toBeNull();

    await select("Gamma");
    fireEvent.click(screen.getByRole("button", { name: "Sage paper" }));
    expect(screen.queryByRole("status", { name: /selected/ })).toBeNull();
    await select("Gamma");
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    expect(screen.queryByRole("status", { name: /selected/ })).toBeNull();
  });

  it("preserves a failed batch-trash selection and shows the operation error", async () => {
    mocks.trashMany.mockRejectedValueOnce("A selected note could not be saved");
    renderLibrary();
    await select("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select Alpha" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("1 selected");
    expect(mocks.trashMany).toHaveBeenCalledWith(["alpha"]);
  });

  it("confirms permanent deletion with the selected count before purging", async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await select("Old note");
    await select("Ancient note");
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(await screen.findByRole("dialog", { name: /2 selected/ })).toBeTruthy();
    expect(mocks.purgeMany).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete 2 notes" }));
    await waitFor(() => expect(mocks.purgeMany).toHaveBeenCalledWith(["old-note", "ancient-note"]));
  });

  it("executes single Trash confirmations after closing the dialog", async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await select("Old note");
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete Old note" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete note" }));
    await waitFor(() => expect(mocks.purge).toHaveBeenCalledWith("old-note"));

    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    const emptyTrashDialog = await screen.findByRole("dialog");
    fireEvent.click(within(emptyTrashDialog).getByRole("button", { name: "Empty Trash" }));
    await waitFor(() => expect(mocks.emptyTrash).toHaveBeenCalledOnce());
  });

  it("routes the tray show event to Notes and displays native string errors", async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => expect(mocks.events.some(event => event.name === "library-show-notes")).toBe(true));
    const showNotes = mocks.events.find(event => event.name === "library-show-notes")!;
    const appError = mocks.events.find(event => event.name === "app-error")!;
    act(() => showNotes.handler({ payload: null }));
    expect(await screen.findByRole("searchbox", { name: "Search notes" })).toBeTruthy();
    act(() => appError.handler({ payload: "A native operation needs attention." }));
    expect(await screen.findByRole("alert").then(element => element.textContent)).toContain("A native operation needs attention.");
  });
});
