// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Window as NativeWindow } from "@tauri-apps/api/window";
import { KeepOnTopButton, useKeepOnTop } from "./KeepOnTop";

const mocks = vi.hoisted(() => ({
  getPlatformCapabilities: vi.fn(),
}));

vi.mock("./api", () => ({ notesApi: { getPlatformCapabilities: mocks.getPlatformCapabilities } }));

type WindowMock = {
  isAlwaysOnTop: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
};

function makeWindow(initial = false): WindowMock {
  return {
    isAlwaysOnTop: vi.fn<() => Promise<boolean>>().mockResolvedValue(initial),
    setAlwaysOnTop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function Harness({ nativeWindow, disabled = false }: { nativeWindow: WindowMock; disabled?: boolean }) {
  const controller = useKeepOnTop(nativeWindow as unknown as NativeWindow);
  return <>
    <KeepOnTopButton controller={controller} disabled={disabled} />
    {controller.error && <div role="alert"><span>{controller.error}</span><button type="button" onClick={() => void controller.retry()}>Retry</button></div>}
  </>;
}

describe("Keep on top control", () => {
  beforeEach(() => {
    mocks.getPlatformCapabilities.mockReset().mockResolvedValue({ absoluteWindowPosition: true, alwaysOnTop: true });
  });

  afterEach(() => cleanup());

  it("initializes from the current native window state", async () => {
    const nativeWindow = makeWindow(true);
    render(<Harness nativeWindow={nativeWindow} />);
    const button = await screen.findByRole("button", { name: "Keep on top" });
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(nativeWindow.isAlwaysOnTop).toHaveBeenCalledOnce();
  });

  it("offers retry when initialization fails", async () => {
    const nativeWindow = makeWindow();
    mocks.getPlatformCapabilities.mockRejectedValueOnce(new Error("capability lookup failed")).mockResolvedValueOnce({ absoluteWindowPosition: true, alwaysOnTop: true });
    render(<Harness nativeWindow={nativeWindow} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't initialize Keep on top. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(nativeWindow.isAlwaysOnTop).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the previous state and exposes recovery after a setter failure", async () => {
    const nativeWindow = makeWindow(false);
    nativeWindow.setAlwaysOnTop.mockRejectedValueOnce(new Error("native setter failed")).mockResolvedValueOnce(undefined);
    render(<Harness nativeWindow={nativeWindow} />);
    const button = await screen.findByRole("button", { name: "Keep on top" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't change Keep on top. Try again.");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(nativeWindow.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true);
    expect(nativeWindow.setAlwaysOnTop).toHaveBeenNthCalledWith(2, true);
  });

  it("blocks rapid repeated activation while the native setter is pending", async () => {
    const nativeWindow = makeWindow(false);
    let resolveSetter!: () => void;
    nativeWindow.setAlwaysOnTop.mockImplementationOnce(() => new Promise<void>(resolve => { resolveSetter = resolve; }));
    render(<Harness nativeWindow={nativeWindow} />);
    const button = await screen.findByRole("button", { name: "Keep on top" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(nativeWindow.setAlwaysOnTop).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => { resolveSetter(); });
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
  });

  it("keeps unsupported sessions discoverable and explains why activation is unavailable", async () => {
    const nativeWindow = makeWindow(false);
    mocks.getPlatformCapabilities.mockResolvedValue({ absoluteWindowPosition: false, alwaysOnTop: false });
    render(<Harness nativeWindow={nativeWindow} />);
    const button = await screen.findByRole("button", { name: "Keep on top" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Keep on top isn't available in this desktop session.")).toBeTruthy();
    fireEvent.click(button);
    expect(nativeWindow.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("keeps each note window's native state independent", async () => {
    const first = makeWindow(false);
    const second = makeWindow(true);
    render(<><Harness nativeWindow={first} /><Harness nativeWindow={second} /></>);
    const buttons = await screen.findAllByRole("button", { name: "Keep on top" });
    await waitFor(() => {
      expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
      expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(buttons[0].getAttribute("aria-pressed")).toBe("true"));
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(buttons[1].getAttribute("aria-pressed")).toBe("false"));
    expect(first.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(second.setAlwaysOnTop).toHaveBeenCalledWith(false);
  });

  it("does not allow changes while the note is locked", async () => {
    const nativeWindow = makeWindow(false);
    render(<Harness nativeWindow={nativeWindow} disabled />);
    const button = await screen.findByRole("button", { name: "Keep on top" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    expect(nativeWindow.setAlwaysOnTop).not.toHaveBeenCalled();
  });
});
