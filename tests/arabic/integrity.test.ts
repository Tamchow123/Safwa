/**
 * Arabic integrity suite. All expected values are derived from the
 * datasets themselves or expressed as programmatically generated ASCII
 * escapes -- never typed as rendered Arabic literals in this file
 * (CLAUDE.md, Arabic data-handling rule).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isNfc, toEscaped } from "@/shared/arabic/extract";
import { normalizeForComparison } from "@/shared/arabic/normalize";

const ROOT = join(import.meta.dirname, "..", "..");

type RawEntry = Record<string, unknown> & { id: number };

const original = JSON.parse(
  readFileSync(join(ROOT, "data", "safwa-mujarrad.original.json"), "utf8"),
) as { entries: RawEntry[] };
const enriched = JSON.parse(
  readFileSync(join(ROOT, "data", "safwa-vocabulary.v2.json"), "utf8"),
) as { mujarrad_entries: RawEntry[] };

const originalById = new Map(original.entries.map((e) => [e.id, e]));
const enrichedById = new Map(enriched.mujarrad_entries.map((e) => [e.id, e]));

const SOURCE_FIELDS = [
  "madi",
  "mudari",
  "masdar",
  "meaning",
  "ism_fail",
  "amr",
  "nahi",
  "bab",
  "bab_arabic",
  "verb_type",
  "verb_type_arabic",
  "book_page",
] as const;

const ARABIC_FIELDS = [
  "madi",
  "mudari",
  "masdar",
  "ism_fail",
  "amr",
  "nahi",
  "bab_arabic",
  "verb_type_arabic",
] as const;

describe("original vs enriched source preservation", () => {
  it("every source field of every entry is byte-identical", () => {
    expect(original.entries).toHaveLength(455);
    expect(enriched.mujarrad_entries).toHaveLength(455);
    for (const entry of original.entries) {
      const twin = enrichedById.get(entry.id)!;
      for (const field of SOURCE_FIELDS) {
        expect(twin[field], `entry ${entry.id} field ${field}`).toEqual(
          entry[field],
        );
      }
    }
  });

  it("every Arabic source field is NFC", () => {
    for (const entry of original.entries) {
      for (const field of ARABIC_FIELDS) {
        expect(
          isNfc(entry[field] as string),
          `entry ${entry.id} field ${field} not NFC`,
        ).toBe(true);
      }
    }
  });
});

describe("known unresolved-root entries", () => {
  // Escapes generated programmatically from explicit codepoints.
  const EXPECTED = {
    369: { madi: "\u0637\u064e\u0627\u062d\u064e", madiCodepoints: 5 },
    372: { madi: "\u063a\u064e\u0627\u0637\u064e", madiCodepoints: 5 },
  } as const;

  it.each([369, 372] as const)(
    "entry %d matches the immutable original",
    (id) => {
      const orig = originalById.get(id)!;
      const enr = enrichedById.get(id)!;
      expect(enr.madi).toBe(orig.madi);
      expect(enr.mudari).toBe(orig.mudari);
      expect(orig.madi).toBe(EXPECTED[id].madi);
      expect([...(orig.madi as string)]).toHaveLength(
        EXPECTED[id].madiCodepoints,
      );
      expect(toEscaped(orig.madi as string)).toBe(toEscaped(EXPECTED[id].madi));
    },
  );
});

describe("bab_arabic groups", () => {
  it("all six babs have one consistent bab_arabic across both datasets", () => {
    const babs = new Map<string, Set<string>>();
    for (const entry of [...original.entries, ...enriched.mujarrad_entries]) {
      const bab = entry.bab as string;
      (babs.get(bab) ?? babs.set(bab, new Set()).get(bab)!).add(
        entry.bab_arabic as string,
      );
    }
    expect([...babs.keys()].sort()).toEqual([
      "daraba",
      "fataha",
      "hasiba",
      "karuma",
      "nasara",
      "samia",
    ]);
    for (const [bab, values] of babs) {
      expect(values.size, `bab ${bab} bab_arabic inconsistent`).toBe(1);
      const value = [...values][0];
      expect(isNfc(value)).toBe(true);
      expect([...value]).toHaveLength(15);
    }
  });
});

describe("protected duplicate-madi groups", () => {
  const GROUPS = [
    [262, 275],
    [297, 303],
    [409, 413],
  ] as const;

  it("groups are exactly the expected ids", () => {
    const byMadi = new Map<string, number[]>();
    for (const entry of original.entries) {
      const madi = entry.madi as string;
      byMadi.set(madi, [...(byMadi.get(madi) ?? []), entry.id]);
    }
    const duplicates = [...byMadi.values()]
      .filter((ids) => ids.length > 1)
      .map((ids) => [...ids].sort((a, b) => a - b))
      .sort((a, b) => a[0] - b[0]);
    expect(duplicates).toEqual(GROUPS.map((g) => [...g]));
  });

  it.each(GROUPS.map((g) => [...g] as [number, number]))(
    "group %d/%d keeps distinct mudari in both datasets",
    (a, b) => {
      expect(originalById.get(a)!.madi).toBe(originalById.get(b)!.madi);
      expect(originalById.get(a)!.mudari).not.toBe(originalById.get(b)!.mudari);
      expect(enrichedById.get(a)!.mudari).toBe(originalById.get(a)!.mudari);
      expect(enrichedById.get(b)!.mudari).toBe(originalById.get(b)!.mudari);
    },
  );
});

describe("meaningful distinctions survive comparison normalisation", () => {
  it("shaddah/harakat/hamzah distinctions are preserved", () => {
    // The duplicate groups differ ONLY in harakat/weak letters of mudari --
    // normalisation must NOT collapse them.
    for (const [a, b] of [
      [262, 275],
      [297, 303],
      [409, 413],
    ]) {
      const left = normalizeForComparison(
        originalById.get(a)!.mudari as string,
      );
      const right = normalizeForComparison(
        originalById.get(b)!.mudari as string,
      );
      expect(left).not.toBe(right);
    }
  });

  it("display strings are not mutated by comparison utilities", () => {
    const value = originalById.get(1)!.madi as string;
    const copy = value;
    normalizeForComparison(value);
    expect(value).toBe(copy);
    // NFC input passes through unchanged (values are already NFC).
    expect(normalizeForComparison(value)).toBe(value);
  });
});

describe("normalisation removes only approved invisible characters", () => {
  it("strips the documented invisibles and trims", () => {
    const base = originalById.get(1)!.madi as string;
    const noisy = "\u200b \ufeff" + base + "\u200f\u2060 \u061c";
    expect(normalizeForComparison(noisy)).toBe(base);
  });

  it("does not strip harakat, shaddah, sukun or dagger alif", () => {
    // Entry 413 mudari contains a dagger alif (U+0670); entry 262 contains
    // shaddah (U+0651) -- both must survive normalisation.
    const withDagger = originalById.get(413)!.mudari as string;
    expect(normalizeForComparison(withDagger)).toBe(withDagger);
    expect(withDagger).toContain("\u0670");
    const withShaddah = originalById.get(262)!.mudari as string;
    expect(normalizeForComparison(withShaddah)).toBe(withShaddah);
    expect(withShaddah).toContain("\u0651");
  });
});
