import { describe, expect, it } from "vitest";

import {
  parsePlaceholder,
  resolvePlaceholder,
  verifyRecord,
  type SidecarRecord,
} from "@/tools/docs-verify";
import { toEscaped } from "@/shared/arabic/extract";

// Fixture values built from explicit codepoints (never hand-typed Arabic).
const VALUE = String.fromCodePoint(0x0637, 0x064e); // TAH + FATHA
const OTHER = String.fromCodePoint(0x063a, 0x064e); // GHAIN + FATHA

function datasets(overrides?: {
  enrichedValue?: string;
  babValues?: [string, string];
}) {
  const entry = { id: 5, madi: VALUE, bab: "nasara", bab_arabic: VALUE };
  const enrichedEntry = {
    ...entry,
    madi: overrides?.enrichedValue ?? VALUE,
    bab_arabic: overrides?.babValues?.[1] ?? VALUE,
  };
  return {
    originalById: new Map([[5, entry]]),
    enrichedById: new Map([[5, enrichedEntry]]),
  };
}

describe("parsePlaceholder", () => {
  it("parses entry and bab placeholders", () => {
    expect(parsePlaceholder("{{entry:369:madi}}")).toEqual({
      kind: "entry",
      entryId: 369,
      field: "madi",
    });
    expect(parsePlaceholder("{{bab:nasara:bab_arabic}}")).toEqual({
      kind: "bab",
      babId: "nasara",
    });
  });

  it("rejects unsupported placeholders", () => {
    for (const bad of [
      "{{entry:abc:madi}}",
      "{{bab:nasara:madi}}",
      "{{entry:1}}",
      "entry:1:madi",
      "{{unknown:1:x}}",
    ]) {
      expect(() => parsePlaceholder(bad), bad).toThrow();
    }
  });
});

describe("resolvePlaceholder", () => {
  it("resolves an entry field when original == enriched", () => {
    expect(
      resolvePlaceholder(
        { kind: "entry", entryId: 5, field: "madi" },
        datasets(),
      ),
    ).toBe(VALUE);
  });

  it("fails when original and enriched differ", () => {
    expect(() =>
      resolvePlaceholder(
        { kind: "entry", entryId: 5, field: "madi" },
        datasets({ enrichedValue: OTHER }),
      ),
    ).toThrow(/differ/);
  });

  it("fails for a missing entry or field", () => {
    expect(() =>
      resolvePlaceholder(
        { kind: "entry", entryId: 99, field: "madi" },
        datasets(),
      ),
    ).toThrow(/not found/);
    expect(() =>
      resolvePlaceholder(
        { kind: "entry", entryId: 5, field: "nope" },
        datasets(),
      ),
    ).toThrow(/missing/);
  });

  it("fails for inconsistent bab_arabic values", () => {
    expect(() =>
      resolvePlaceholder(
        { kind: "bab", babId: "nasara" },
        datasets({ babValues: [VALUE, OTHER] }),
      ),
    ).toThrow(/inconsistent/);
  });
});

describe("verifyRecord", () => {
  const record: SidecarRecord = {
    file: "docs/X.md",
    placeholder: "{{entry:5:madi}}",
    value: VALUE,
    escaped: toEscaped(VALUE),
    codepoints: 2,
  };

  it("passes when everything matches", () => {
    expect(
      verifyRecord(record, datasets(), () => `text ${VALUE} text`),
    ).toEqual([]);
  });

  it("fails when the sidecar value drifted", () => {
    const drifted = { ...record, value: OTHER };
    const problems = verifyRecord(drifted, datasets(), () => `x ${VALUE}`);
    expect(problems.join(" ")).toMatch(/value drifted/);
  });

  it("fails when the doc no longer contains the value", () => {
    const problems = verifyRecord(record, datasets(), () => "altered content");
    expect(problems.join(" ")).toMatch(/no longer contains/);
  });

  it("fails when the doc file is missing", () => {
    const problems = verifyRecord(record, datasets(), () => null);
    expect(problems.join(" ")).toMatch(/missing/);
  });

  it("fails when the escaped form or codepoint count drifted", () => {
    expect(
      verifyRecord(
        { ...record, escaped: "\\u0000" },
        datasets(),
        () => VALUE,
      ).join(" "),
    ).toMatch(/escape drifted/);
    expect(
      verifyRecord({ ...record, codepoints: 7 }, datasets(), () => VALUE).join(
        " ",
      ),
    ).toMatch(/codepoint count drifted/);
  });
});
