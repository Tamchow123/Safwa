import { describe, expect, it } from "vitest";

import {
  answerComparisonKey,
  answerValuesEqual,
} from "@/modules/study-engine/fields";

describe("field-aware answer comparison (CLAUDE.md hard rule 4)", () => {
  it("compares non-masdar fields by the normalise-only policy", () => {
    // Non-masdar fields do not split on " / ".
    expect(answerComparisonKey("meaning", "to write")).toBe("to write");
    expect(answerValuesEqual("madi", "كَتَبَ", "كَتَبَ")).toBe(true);
    expect(answerValuesEqual("madi", "كَتَبَ", "كَتُبَ")).toBe(false); // ḥarakāt matter
  });

  it("splits masdar alternatives and compares the order-independent set", () => {
    // Same alternatives in a different order are equal for masdar...
    expect(answerValuesEqual("masdar", "أ / ب", "ب / أ")).toBe(true);
    // ...but NOT for another field (whole-cell compare).
    expect(answerValuesEqual("madi", "أ / ب", "ب / أ")).toBe(false);
    // Different alternative sets are not equal.
    expect(answerValuesEqual("masdar", "أ / ب", "أ / ج")).toBe(false);
    // A single-alternative masdar equals itself and is unaffected by splitting.
    expect(answerValuesEqual("masdar", "أ", "أ")).toBe(true);
    expect(answerValuesEqual("masdar", "أ", "ب")).toBe(false);
  });

  it("compares masdar as a true SET (repeated members deduplicated)", () => {
    // Same alternative set, one with a repeated member — equal under set
    // semantics (not multiset).
    expect(answerValuesEqual("masdar", "أ / ب", "أ / ب / ب")).toBe(true);
    expect(answerValuesEqual("masdar", "أ / ب / أ", "ب / أ")).toBe(true);
    // Genuinely different sets stay unequal.
    expect(answerValuesEqual("masdar", "أ / ب / ب", "أ / ج")).toBe(false);
  });
});
