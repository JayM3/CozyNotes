import { describe, expect, it } from "vitest";
import { findTextMatches, normalizeSearchText } from "./textSearch";

describe("normalizeSearchText", () => {
  it("uses canonical normalization and full default folding", () => {
    expect(normalizeSearchText("Stra\u00dfe \u03c2 \u212a CAFE\u0301")).toBe("strasse \u03c3 k caf\u00e9");
    expect(normalizeSearchText("\u0130")).toBe("i\u0307");
  });
});

describe("findTextMatches", () => {
  it("matches literal punctuation and preserves whitespace", () => {
    expect(findTextMatches("a.b [x] aXb", "a.b")).toEqual([{ from: 0, to: 3 }]);
    expect(findTextMatches("a.b [x] aXb", "[x]")).toEqual([{ from: 4, to: 7 }]);
    expect(findTextMatches("a  b a b", "a b")).toEqual([{ from: 5, to: 8 }]);
    expect(findTextMatches("anything", "")).toEqual([]);
  });

  it("maps folded expansions back to the original characters once", () => {
    expect(findTextMatches("Stra\u00dfe STRASSE", "strasse")).toEqual([{ from: 0, to: 6 }, { from: 7, to: 14 }]);
    expect(findTextMatches("\u00dfs", "s")).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }]);
    expect(findTextMatches("\ufb03", "FFI")).toEqual([{ from: 0, to: 1 }]);
  });

  it("maps canonically equivalent combining sequences and reordered marks", () => {
    expect(findTextMatches("Cafe\u0301 CAF\u00c9", "caf\u00e9")).toEqual([{ from: 0, to: 5 }, { from: 6, to: 10 }]);
    expect(findTextMatches("\u00e9", "e\u0301")).toEqual([{ from: 0, to: 1 }]);
    expect(findTextMatches("a\u0301\u0323", "\u1ea1\u0301")).toEqual([{ from: 0, to: 3 }]);
  });

  it("returns UTF-16 ranges without splitting emoji surrogate pairs", () => {
    expect(findTextMatches("\ud83d\ude00 a \ud83d\ude00", "\ud83d\ude00")).toEqual([{ from: 0, to: 2 }, { from: 5, to: 7 }]);
    expect(findTextMatches("\ud83d\udc69\u200d\ud83d\udcbb", "\ud83d\udcbb")).toEqual([{ from: 3, to: 5 }]);
  });

  it("uses non-overlapping literal matches", () => {
    expect(findTextMatches("aaaa", "aa")).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }]);
    expect(findTextMatches("notes", "missing")).toEqual([]);
  });
});
