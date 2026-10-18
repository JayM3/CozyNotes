// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { imageFiles, imageType, MAX_IMAGE_BYTES } from "./imageImport";

describe("image import helpers", () => {
  it("normalizes supported MIME types and falls back to file extensions", () => {
    expect(imageType(new File(["png"], "capture.png", { type: "image/png" }))).toBe("image/png");
    expect(imageType(new File(["jpg"], "capture.jpg"))).toBe("image/jpeg");
    expect(imageType(new File(["svg"], "drawing.svg", { type: "image/svg+xml" }))).toBeNull();
  });

  it("extracts image files from clipboard items before the generic file list", () => {
    const screenshot = new File(["png"], "", { type: "image/png" });
    const text = new File(["text"], "text.txt", { type: "text/plain" });
    const data = {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => screenshot },
      ],
      files: [text],
    } as unknown as DataTransfer;
    expect(imageFiles(data)).toEqual([screenshot]);
  });

  it("keeps the 25 MB import boundary explicit", () => {
    expect(MAX_IMAGE_BYTES).toBe(25 * 1024 * 1024);
  });
});
