import { describe, expect, it } from "vitest";

import type { AnswerField } from "@/modules/content/constants";
import {
  selectDistractors,
  type DistractorCandidate,
  type DistractorTarget,
} from "@/modules/study-engine/distractors";
import { createRng } from "@/modules/study-engine/rng";
import { normalizeForComparison } from "@/shared/arabic/normalize";

const FIELD: AnswerField = "meaning";

function candidate(
  entryId: number,
  value: string,
  extra: Partial<DistractorCandidate> = {},
): DistractorCandidate {
  return {
    ref: { entryId, field: FIELD },
    value,
    entryId,
    bab: extra.bab ?? null,
    verbType: extra.verbType ?? null,
    bookPage: extra.bookPage ?? null,
  };
}

const target: DistractorTarget = {
  correctValue: "to write",
  correctEntryId: 1,
  bab: "nasara",
  verbType: "sahih",
  bookPage: 10,
};

describe("distractor selection", () => {
  it("is deterministic for the same seed", () => {
    const pool = [
      candidate(2, "to read"),
      candidate(3, "to sit"),
      candidate(4, "to open"),
      candidate(5, "to hear"),
      candidate(6, "to help"),
    ];
    const a = selectDistractors(target, pool, 3, createRng("d"));
    const b = selectDistractors(target, pool, 3, createRng("d"));
    expect(a).toEqual(b);
  });

  it("excludes the correct entry and correct value; options stay unique", () => {
    const pool = [
      candidate(1, "to write"), // the correct entry itself
      candidate(2, "to write"), // duplicate surface form of the answer
      candidate(3, "to read"),
      candidate(4, "to read"), // duplicate distractor
      candidate(5, "to sit"),
      candidate(6, "to open"),
    ];
    const chosen = selectDistractors(target, pool, 3, createRng("seed"));
    expect(chosen).toHaveLength(3);
    const values = chosen.map((c) => normalizeForComparison(c.value));
    expect(values).not.toContain(normalizeForComparison("to write"));
    expect(new Set(values).size).toBe(values.length);
    expect(chosen.every((c) => c.entryId !== 1)).toBe(true);
  });

  it("honours an explicit ambiguous-value exclusion set", () => {
    const pool = [
      candidate(2, "to read"),
      candidate(3, "to sit"),
      candidate(4, "to open"),
      candidate(5, "to hear"),
    ];
    const chosen = selectDistractors(
      target,
      pool,
      3,
      createRng("seed"),
      new Set([normalizeForComparison("to read")]),
    );
    expect(chosen.map((c) => c.value)).not.toContain("to read");
  });

  it("prefers plausible candidates (same bab, then verb type, then page)", () => {
    const pool = [
      candidate(2, "same-bab", { bab: "nasara", bookPage: 99 }),
      candidate(3, "same-type", { bab: "daraba", verbType: "sahih" }),
      candidate(4, "same-page", { bab: "samia", bookPage: 10 }),
      candidate(5, "unrelated-a", { bab: "hasiba", bookPage: 500 }),
      candidate(6, "unrelated-b", { bab: "karuma", bookPage: 600 }),
    ];
    // Ask for exactly the three plausible ones.
    const chosen = selectDistractors(target, pool, 3, createRng("plaus"));
    const values = chosen.map((c) => c.value).sort();
    expect(values).toEqual(["same-bab", "same-page", "same-type"]);
  });

  it("keeps the MOST plausible representative of a duplicate surface", () => {
    // Two entries share the surface "dup": the lower id is unrelated, the
    // higher id matches the target's bāb. The related (higher-id) one must win.
    const pool = [
      candidate(2, "dup", { bab: "daraba" }), // unrelated, lower id
      candidate(9, "dup", { bab: "nasara" }), // same bāb as target, higher id
      candidate(3, "filler-a", { bab: "samia" }),
      candidate(4, "filler-b", { bab: "fataha" }),
    ];
    const chosen = selectDistractors(target, pool, 3, createRng("dup"));
    const dup = chosen.find((c) => c.value === "dup");
    expect(dup).toBeDefined();
    expect(dup!.entryId).toBe(9); // the plausible representative, not id 2
  });

  it("returns fewer than requested when the pool is too small", () => {
    const pool = [candidate(2, "to read")];
    const chosen = selectDistractors(target, pool, 3, createRng("small"));
    expect(chosen).toHaveLength(1);
  });
});
