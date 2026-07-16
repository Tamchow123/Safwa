import { describe, expect, it } from "vitest";

import {
  comparisonEvidence,
  isNfc,
  toCodepointList,
  toEscaped,
} from "@/shared/arabic/extract";
import {
  arabicEqual,
  normalizeForComparison,
  splitMasdarAlternatives,
} from "@/shared/arabic/normalize";

/*
 * All non-ASCII literals below are \uXXXX escapes generated
 * programmatically from explicit codepoints (CLAUDE.md rule) -- no
 * hand-typed Arabic appears in this file.
 */

describe("normalizeForComparison", () => {
  it("applies NFC", () => {
    // A + combining ring above (NFD) normalises to the precomposed form.
    expect(normalizeForComparison("A\u030a")).toBe("\u00c5");
  });

  it("removes exactly the documented invisible characters", () => {
    for (const invisible of [
      "\u200b",
      "\u200c",
      "\u200d",
      "\u200e",
      "\u200f",
      "\u061c",
      "\ufeff",
      "\u2060",
    ]) {
      expect(normalizeForComparison(`a${invisible}b`)).toBe("ab");
    }
  });

  it("does not remove other characters", () => {
    // U+2061 (function application) is NOT in the approved removal list.
    expect(normalizeForComparison("a\u2061b")).toBe("a\u2061b");
    // Tatweel (U+0640) is meaningful text, not an approved invisible.
    expect(normalizeForComparison("a\u0640b")).toBe("a\u0640b");
  });

  it("trims surrounding whitespace only", () => {
    expect(normalizeForComparison("  a b  ")).toBe("a b");
  });
});

describe("arabicEqual", () => {
  it("matches values that differ only by invisibles/whitespace", () => {
    expect(arabicEqual(" x\u200b ", "x")).toBe(true);
  });

  it("treats harakat differences as meaningful", () => {
    expect(arabicEqual("\u0628\u064e", "\u0628\u064f")).toBe(false);
    expect(arabicEqual("\u0628", "\u0628\u0651")).toBe(false);
  });
});

describe("splitMasdarAlternatives", () => {
  it("splits on the documented separator", () => {
    expect(splitMasdarAlternatives("a / b")).toEqual(["a", "b"]);
    expect(splitMasdarAlternatives("a")).toEqual(["a"]);
  });
});

describe("extract helpers", () => {
  it("produces U+XXXX codepoint lists", () => {
    expect(toCodepointList("\u0637\u064e")).toBe("U+0637 U+064E");
  });

  it("produces pure-ASCII escapes", () => {
    const escaped = toEscaped("\u0637\u064e");
    expect(escaped).toBe("\\u0637\\u064e");
    expect([...escaped].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });

  it("checks NFC", () => {
    expect(isNfc("\u00c5")).toBe(true);
    expect(isNfc("A\u030a")).toBe(false);
  });

  it("builds ASCII-safe comparison evidence", () => {
    const evidence = comparisonEvidence("\u0628", "\u0628\u0651");
    expect(evidence.equal).toBe(false);
    expect(evidence.aCodepointCount).toBe(1);
    expect(evidence.bCodepointCount).toBe(2);
  });
});
