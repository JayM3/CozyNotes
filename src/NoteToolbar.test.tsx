// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteToolbar } from "./NoteToolbar";

describe("Note toolbar resizing", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("innerHeight", 385);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("resizes with the keyboard, respects limits, and remembers each note separately", () => {
    const { unmount } = render(<NoteToolbar id="first"><button>Bold</button></NoteToolbar>);
    const handle = screen.getByRole("separator", { name: "Toolbar height" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe("100");
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("88");
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe("180");
    unmount();
    const reopened = render(<NoteToolbar id="first">Note</NoteToolbar>);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("180");
    reopened.unmount();
    render(<NoteToolbar id="second">Another note</NoteToolbar>);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("96");
  });

  it("keeps the editing area available in short windows without losing the preferred height", () => {
    localStorage.setItem("cozynotes.toolbar-height.first", "180");
    render(<NoteToolbar id="first">Note</NoteToolbar>);
    act(() => { vi.stubGlobal("innerHeight", 240); window.dispatchEvent(new Event("resize")); });
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("88");
    act(() => { vi.stubGlobal("innerHeight", 385); window.dispatchEvent(new Event("resize")); });
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("180");
  });

  it("falls back from invalid or unavailable preferences and supports resetting the height", () => {
    localStorage.setItem("cozynotes.toolbar-height.first", "NaN");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    render(<NoteToolbar id="first">Note</NoteToolbar>);
    const handle = screen.getByRole("separator");
    expect(handle.getAttribute("aria-valuenow")).toBe("96");
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("96");
  });
});
