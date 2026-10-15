/// <reference lib="es2022.intl" />

import { caseFold } from "unicode-case-folding";

export type TextMatch = { from: number; to: number };

type MappedText = { text: string; starts: number[]; ends: number[] };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function normalizeSearchText(text: string): string {
  return caseFold(text.normalize("NFC")).normalize("NFC");
}

function mapSearchText(text: string): MappedText {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  for (const { segment, index } of graphemes.segment(text)) {
    const folded = normalizeSearchText(segment);
    const characters: Array<{ text: string; from: number; to: number }> = [];
    let offset = index;

    for (const character of segment) {
      characters.push({ text: normalizeSearchText(character), from: offset, to: offset + character.length });
      offset += character.length;
    }

    // Canonical composition can combine or reorder several original characters.
    const mapped = characters.map(character => character.text).join("") === folded
      ? characters
      : [{ text: folded, from: index, to: index + segment.length }];

    parts.push(folded);
    for (const character of mapped) {
      for (let unit = 0; unit < character.text.length; unit++) {
        starts.push(character.from);
        ends.push(character.to);
      }
    }
  }

  return { text: parts.join(""), starts, ends };
}

export function findTextMatches(text: string, query: string): TextMatch[] {
  const needle = normalizeSearchText(query);
  if (!needle) return [];

  const haystack = mapSearchText(text);
  const matches: TextMatch[] = [];
  let searchFrom = 0;

  while (searchFrom <= haystack.text.length - needle.length) {
    const index = haystack.text.indexOf(needle, searchFrom);
    if (index === -1) break;

    const match = { from: haystack.starts[index], to: haystack.ends[index + needle.length - 1] };
    const previous = matches[matches.length - 1];
    if (!previous || match.from >= previous.to) matches.push(match);
    searchFrom = index + needle.length;
  }

  return matches;
}
