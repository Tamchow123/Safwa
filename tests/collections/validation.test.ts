/**
 * Pure validation/canonicalisation for bookmarks and custom lists
 * (Phase 14, docs/phases/phases-14.md sections 8/27).
 */
import { describe, expect, it } from "vitest";

import {
  canCreateAnotherList,
  canonicaliseMembership,
  cleanListNameInput,
  isDuplicateListName,
  isValidEntryId,
  isValidTimestamp,
  LIST_NAME_MAX_LENGTH,
  MAX_LISTS,
  normaliseListNameForComparison,
  resolvableMembership,
  validateListName,
} from "@/modules/collections/validation";

describe("validateListName", () => {
  it("rejects whitespace-only input", () => {
    expect(validateListName("   ").valid).toBe(false);
    expect(validateListName("").valid).toBe(false);
  });

  it("accepts and trims a valid name", () => {
    const result = validateListName("  Difficult Verbs  ");
    expect(result).toEqual({
      valid: true,
      displayName: "Difficult Verbs",
      normalisedName: "difficult verbs",
    });
  });

  it("collapses internal whitespace runs to one ordinary space", () => {
    const result = validateListName(" difficult   verbs ");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.displayName).toBe("difficult verbs");
    }
  });

  it("NFC-normalises the input", () => {
    // Built via String.fromCharCode with explicit codepoints only --
    // never a hand-typed non-ASCII literal (CLAUDE.md hard rule 3).
    // decomposed: 0x63 0x61 0x66 0x65 0x0301 (c a f e + combining acute)
    // precomposed: 0x63 0x61 0x66 0xe9 (c a f e-with-acute)
    const decomposed = String.fromCharCode(0x63, 0x61, 0x66, 0x65, 0x0301);
    const precomposed = String.fromCharCode(0x63, 0x61, 0x66, 0xe9);
    expect(decomposed).not.toBe(precomposed);
    expect(cleanListNameInput(decomposed)).toBe(precomposed);
  });

  it("rejects a name over the maximum length", () => {
    const tooLong = "a".repeat(LIST_NAME_MAX_LENGTH + 1);
    const result = validateListName(tooLong);
    expect(result).toEqual({ valid: false, reason: "too_long" });
  });

  it("accepts a name at exactly the maximum length", () => {
    const exact = "a".repeat(LIST_NAME_MAX_LENGTH);
    expect(validateListName(exact).valid).toBe(true);
  });
});

describe("isDuplicateListName", () => {
  const existing = [
    { id: "list-1", name: "Difficult Verbs" },
    { id: "list-2", name: "Revision week" },
  ];

  it("treats case/whitespace variants as duplicates", () => {
    expect(isDuplicateListName("difficult   verbs", existing)).toBe(true);
    expect(isDuplicateListName("DIFFICULT VERBS", existing)).toBe(true);
    expect(isDuplicateListName(" Difficult Verbs ", existing)).toBe(true);
  });

  it("does not flag a genuinely new name", () => {
    expect(isDuplicateListName("Verb conjugation", existing)).toBe(false);
  });

  it("excludes the list's own id (rename to own equivalent name)", () => {
    expect(isDuplicateListName("difficult verbs", existing, "list-1")).toBe(
      false,
    );
    expect(isDuplicateListName("difficult verbs", existing, "list-2")).toBe(
      true,
    );
  });
});

describe("normaliseListNameForComparison", () => {
  it("is locale-independent (ASCII lower-casing only)", () => {
    expect(normaliseListNameForComparison("DIFFICULT VERBS")).toBe(
      "difficult verbs",
    );
  });
});

describe("canCreateAnotherList", () => {
  it("allows creation under the cap", () => {
    expect(canCreateAnotherList(MAX_LISTS - 1)).toBe(true);
  });

  it("blocks creation at the cap", () => {
    expect(canCreateAnotherList(MAX_LISTS)).toBe(false);
  });
});

describe("isValidEntryId", () => {
  it("accepts positive integers", () => {
    expect(isValidEntryId(1)).toBe(true);
    expect(isValidEntryId(455)).toBe(true);
  });

  it("rejects zero, negatives, non-integers and non-finite values", () => {
    expect(isValidEntryId(0)).toBe(false);
    expect(isValidEntryId(-1)).toBe(false);
    expect(isValidEntryId(1.5)).toBe(false);
    expect(isValidEntryId(Number.NaN)).toBe(false);
    expect(isValidEntryId(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("canonicaliseMembership", () => {
  it("sorts numerically ascending", () => {
    expect(canonicaliseMembership([30, 2, 100, 9])).toEqual([2, 9, 30, 100]);
  });

  it("deduplicates", () => {
    expect(canonicaliseMembership([7, 7, 9, 7])).toEqual([7, 9]);
  });

  it("rejects invalid ids while keeping valid ones", () => {
    expect(canonicaliseMembership([7, -1, 0, 1.5, Number.NaN, 9])).toEqual([
      7, 9,
    ]);
  });

  it("input order never affects the result", () => {
    expect(canonicaliseMembership([9, 7, 30])).toEqual(
      canonicaliseMembership([30, 7, 9]),
    );
  });
});

describe("resolvableMembership", () => {
  it("excludes ids the active release cannot resolve", () => {
    const known = new Set([1, 2, 3]);
    expect(resolvableMembership([1, 2, 3, 999], known)).toEqual([1, 2, 3]);
  });

  it("preserves protected duplicate entries independently", () => {
    // Protected duplicate-madi group ids (262, 275) - see
    // docs/vocabulary-audit.md; kept as plain numeric ids here, no Arabic.
    const known = new Set([262, 275]);
    expect(resolvableMembership([262, 275, 999], known)).toEqual([262, 275]);
  });
});

describe("isValidTimestamp", () => {
  it("accepts finite non-negative integers", () => {
    expect(isValidTimestamp(0)).toBe(true);
    expect(isValidTimestamp(1_700_000_000_000)).toBe(true);
  });

  it("rejects negative, non-integer and non-finite values", () => {
    expect(isValidTimestamp(-1)).toBe(false);
    expect(isValidTimestamp(1.5)).toBe(false);
    expect(isValidTimestamp(Number.NaN)).toBe(false);
    expect(isValidTimestamp(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
