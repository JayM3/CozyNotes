// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewNoteDefaults } from "./NewNoteDefaults";
import { factoryNoteDefaults } from "./noteDefaults";

afterEach(cleanup);

describe("new note defaults", () => {
  it("previews choices without saving, then saves the complete group", async () => {
    const save = vi.fn(async value => value);
    render(<NewNoteDefaults initial={factoryNoteDefaults} busy={false} onSave={save} />);
    fireEvent.click(screen.getByRole("radio", { name: "Sage" }));
    fireEvent.change(screen.getByLabelText("Note font"), { target: { value: "nunito" } });
    fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Note size"), { target: { value: "roomy" } });
    expect(screen.getByText("400 × 500 logical pixels")).toBeTruthy();
    expect(screen.getByText("A little room for ideas").closest(".defaults-preview-note")?.getAttribute("style")).toContain("Nunito");
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ color: "sage", fontFamily: "nunito", fontSize: 20, width: 400, height: 500 }));
    expect(await screen.findByText(/Defaults saved/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save defaults" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("preserves an unsaved draft through unrelated settings updates and failed saves", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockImplementation(async value => value);
    const view = render(<NewNoteDefaults initial={factoryNoteDefaults} busy={false} onSave={save} />);
    fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "24" } });
    view.rerender(<NewNoteDefaults initial={{ ...factoryNoteDefaults }} busy={true} onSave={save} />);
    view.rerender(<NewNoteDefaults initial={{ ...factoryNoteDefaults }} busy={false} onSave={save} />);
    expect((screen.getByLabelText("Text size") as HTMLSelectElement).value).toBe("24");
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Disk full");
    expect((screen.getByLabelText("Text size") as HTMLSelectElement).value).toBe("24");
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await screen.findByText(/Defaults saved/);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("blocks invalid custom dimensions and requires saving a factory reset", async () => {
    const save = vi.fn(async value => value);
    render(<NewNoteDefaults initial={{ ...factoryNoteDefaults, width: 400, fontSize: 20 }} busy={false} onSave={save} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "304" } });
    expect(screen.getByRole("spinbutton", { name: "Width" }).getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Save defaults" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "400.5" } });
    expect((screen.getByRole("button", { name: "Save defaults" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset to CozyNotes defaults" }));
    expect(save).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Text size") as HTMLSelectElement).value).toBe("16");
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(factoryNoteDefaults));
  });
});
