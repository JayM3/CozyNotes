import type { CSSProperties } from "react";
import type { NoteDefaults, NoteFont, NoteFontSize } from "./api";

export const readingSizes: readonly NoteFontSize[] = [12, 14, 16, 18, 20, 24];
export const noteFonts: { id: NoteFont; label: string; stack: string }[] = [
  { id: "source-sans-3", label: "Source Sans 3", stack: '"Source Sans 3", "Segoe UI", sans-serif' },
  { id: "nunito", label: "Nunito", stack: '"Nunito", "Segoe UI", sans-serif' },
];
export const factoryNoteDefaults: NoteDefaults = {
  color: "cream", fontFamily: "source-sans-3", fontSize: 16, width: 305, height: 385,
};
export const noteSizePresets = [
  { id: "classic", label: "Classic", width: 305, height: 385 },
  { id: "roomy", label: "Roomy", width: 400, height: 500 },
  { id: "large", label: "Large", width: 520, height: 640 },
] as const;

export function noteTypography(font: NoteFont, size: number): CSSProperties {
  return {
    "--note-font": (noteFonts.find(value => value.id === font) ?? noteFonts[0]).stack,
    "--reading-size": `${size}px`,
  } as CSSProperties;
}

export function nextReadingSize(current: number, direction: number): NoteFontSize {
  return readingSizes[Math.max(0, Math.min(readingSizes.length - 1, readingSizes.indexOf(current as NoteFontSize) + direction))];
}
