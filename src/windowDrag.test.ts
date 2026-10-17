// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startWindowDrag } from "./windowDrag";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const startDragging = vi.fn<() => Promise<void>>();

function renderRegion() {
  return render(createElement("header", { onMouseDown: startWindowDrag, "data-testid": "region" },
    createElement("span", null, "Saved on this device"),
    createElement("button", { "aria-label": "Format" }, createElement("svg", { "data-testid": "icon" })),
    createElement("button", { disabled: true }, "Disabled"),
    createElement("input", { "aria-label": "Search" }),
    createElement("div", { role: "menu" }, createElement("span", null, "Menu content")),
    createElement("div", { contentEditable: true, suppressContentEditableWarning: true }, "Editable text"),
  ));
}

describe("frameless window dragging", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    startDragging.mockReset().mockResolvedValue();
    vi.mocked(getCurrentWindow).mockReturnValue({ startDragging } as unknown as ReturnType<typeof getCurrentWindow>);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("starts one native drag from empty chrome and stops the document drag listener", () => {
    const nativeListener = vi.fn();
    document.addEventListener("mousedown", nativeListener);
    try {
      const { getByTestId } = renderRegion();
      expect(fireEvent.mouseDown(getByTestId("region"), { button: 0, detail: 1 })).toBe(false);
      expect(startDragging).toHaveBeenCalledOnce();
      expect(nativeListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("mousedown", nativeListener);
    }
  });

  it("also drags from noninteractive children such as the saved label", () => {
    const { getByText } = renderRegion();
    fireEvent.mouseDown(getByText("Saved on this device"), { button: 0, detail: 1 });
    expect(startDragging).toHaveBeenCalledOnce();
  });

  it("leaves controls, their icons, open menus, and editable content interactive", () => {
    const { getByRole, getByTestId, getByText } = renderRegion();
    const targets = [getByRole("button", { name: "Format" }), getByTestId("icon"), getByRole("button", { name: "Disabled" }), getByRole("textbox"), getByText("Menu content"), getByText("Editable text")];
    for (const target of targets) {
      expect(fireEvent.mouseDown(target, { button: 0, detail: 1 })).toBe(true);
    }
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("ignores secondary buttons and leaves double clicks to Tauri", () => {
    const { getByTestId } = renderRegion();
    for (const press of [{ button: 1, detail: 1 }, { button: 2, detail: 1 }, { button: 0, detail: 2 }]) {
      expect(fireEvent.mouseDown(getByTestId("region"), press)).toBe(true);
    }
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("does not invoke native commands in the browser preview", () => {
    vi.unstubAllGlobals();
    const { getByTestId } = renderRegion();
    fireEvent.mouseDown(getByTestId("region"), { button: 0, detail: 1 });
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("handles a rejected native drag without an unhandled promise", async () => {
    const error = new Error("Window unavailable");
    startDragging.mockRejectedValueOnce(error);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getByTestId } = renderRegion();
    fireEvent.mouseDown(getByTestId("region"), { button: 0, detail: 1 });
    await Promise.resolve();
    expect(logged).toHaveBeenCalledWith("Couldn't move the window.", error);
  });
});
