// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteHistory } from "./NoteHistory";
import { notesApi } from "./api";

vi.mock("./api", () => ({ notesApi: { history: vi.fn(), historyVersion: vi.fn() } }));
const entry = { revision: 4, savedAt: 1000, title: "Earlier title", preview: "Earlier text" };
const version = { ...entry, fontFamily: "nunito" as const, fontSize: 20 as const, explicitTitle: "Earlier title", plainText: "Earlier text", color: "sage" as const, document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Earlier text" }] }] } };

describe("note history", () => {
  beforeEach(() => {
    vi.mocked(notesApi.history).mockReset().mockResolvedValue([entry]);
    vi.mocked(notesApi.historyVersion).mockReset().mockResolvedValue(version);
  });
  afterEach(cleanup);

  it("previews an earlier version read-only and restores its revision as a copy", async () => {
    const restore = vi.fn().mockResolvedValue(undefined), close = vi.fn();
    render(<NoteHistory id="original" onClose={close} onRestore={restore} />);
    fireEvent.click(await screen.findByRole("button", { name: /Earlier title/ }));
    const button = await screen.findByRole("button", { name: "Restore as new note" });
    expect(screen.getByLabelText("Saved note content").getAttribute("contenteditable")).toBe("false");
    expect(screen.getByLabelText("Saved note content").closest(".history-preview")?.getAttribute("style")).toContain("20px");
    expect(screen.getByLabelText("Saved note content").closest(".history-preview")?.getAttribute("style")).toContain("Nunito");
    expect(notesApi.historyVersion).toHaveBeenCalledWith("original", 4);
    fireEvent.click(button);
    await waitFor(() => expect(restore).toHaveBeenCalledWith(4));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("leaves the preview open with a retryable error when restoration fails", async () => {
    const close=vi.fn();
    render(<NoteHistory id="original" onClose={close} onRestore={vi.fn().mockRejectedValue(new Error("Disk full"))} />);
    fireEvent.click(await screen.findByRole("button", { name: /Earlier title/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore as new note" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your current note is unchanged");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Saved note content").textContent).toBe("Earlier text");
  });

  it("explains an empty history and closes with Escape", async () => {
    vi.mocked(notesApi.history).mockResolvedValue([]);
    const close=vi.fn();
    render(<NoteHistory id="original" onClose={close} onRestore={vi.fn()} />);
    await screen.findByText(/No earlier versions yet/);
    fireEvent.keyDown(screen.getByRole("dialog"), {key:"Escape"});
    expect(close).toHaveBeenCalledOnce();
  });

  it("can retry a failed history load", async () => {
    vi.mocked(notesApi.history).mockRejectedValueOnce(new Error("Unavailable"));
    render(<NoteHistory id="original" onClose={vi.fn()} onRestore={vi.fn()} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", {name:"Retry"}));
    await screen.findByRole("button", {name:/Earlier title/});
  });
});
