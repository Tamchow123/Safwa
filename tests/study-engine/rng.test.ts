import { describe, expect, it } from "vitest";

import {
  canonicalKey,
  createRng,
  seedFrom,
  stableHash128Hex,
} from "@/modules/study-engine/rng";

describe("deterministic RNG", () => {
  it("produces an identical sequence for the same seed", () => {
    const a = createRng("seed-alpha");
    const b = createRng("seed-alpha");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = Array.from({ length: 20 }, createRng("seed-alpha").next);
    const b = Array.from({ length: 20 }, createRng("seed-beta").next);
    expect(a).not.toEqual(b);
  });

  it("keeps floats in [0, 1)", () => {
    const rng = createRng("range");
    for (let i = 0; i < 1000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("int() stays within bounds and rejects invalid bounds", () => {
    const rng = createRng("ints");
    for (let i = 0; i < 500; i++) {
      const value = rng.int(6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(() => createRng("x").int(0)).toThrow();
    expect(() => createRng("x").int(-1)).toThrow();
  });

  it("shuffle is deterministic, non-mutating and a permutation", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const one = createRng("shuffle").shuffle(input);
    const two = createRng("shuffle").shuffle(input);
    expect(one).toEqual(two);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // untouched
    expect([...one].sort((a, b) => a - b)).toEqual(input);
    // A different seed yields a (very likely) different order.
    const other = createRng("shuffle-other").shuffle(input);
    expect(one).not.toEqual(other);
  });

  it("stableHash128Hex is deterministic, 32 hex chars, collision-resistant", () => {
    expect(stableHash128Hex("hello")).toBe(stableHash128Hex("hello"));
    expect(stableHash128Hex("hello")).toMatch(/^[0-9a-f]{32}$/);
    expect(stableHash128Hex("hello")).not.toBe(stableHash128Hex("world"));
    // A large sample of distinct inputs produces no collisions.
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(stableHash128Hex(`v-${i}`));
    expect(seen.size).toBe(5000);
  });

  it("seedFrom joins parts with a `|` separator (not injective)", () => {
    expect(seedFrom("a", 1, "b")).toBe("a|1|b");
    expect(seedFrom("a", 1)).not.toBe(seedFrom("a1"));
  });

  it("canonicalKey is injective even when parts contain the delimiter", () => {
    // The classic delimiter-ambiguity collision: seedFrom collapses these two
    // distinct tuples to the same string; canonicalKey must NOT.
    const tupleA = ["a", "mc", 0, "x|flashcard|2|madi"];
    const tupleB = ["a|mc|0|x", "flashcard", 2, "madi"];
    expect(seedFrom(...tupleA)).toBe(seedFrom(...tupleB)); // ambiguous
    expect(canonicalKey(tupleA)).not.toBe(canonicalKey(tupleB)); // injective
    // Deterministic and stable.
    expect(canonicalKey(["a", 1, "b"])).toBe(canonicalKey(["a", 1, "b"]));
    // Type-tagged: a string and a number of equal text never collapse.
    expect(canonicalKey(["1"])).not.toBe(canonicalKey([1]));
    expect(canonicalKey(["10", "1"])).not.toBe(canonicalKey(["1", "01"]));
  });
});
