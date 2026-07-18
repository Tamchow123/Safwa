import { describe, expect, it } from "vitest";

import { uuidv7, uuidVersion } from "@/lib/uuid";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("produces a well-formed version-7, variant-10 UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_PATTERN);
    expect(uuidVersion(id)).toBe(7);
    // Variant bits: the first hex digit of the 4th group is 8, 9, a or b.
    expect(id[19]).toMatch(/[89ab]/);
  });

  it("embeds the millisecond timestamp in the leading 48 bits (sortable)", () => {
    const earlier = uuidv7(1_000_000_000_000);
    const later = uuidv7(2_000_000_000_000);
    const tsHex = (id: string) => id.slice(0, 8) + id.slice(9, 13);
    expect(tsHex(earlier) < tsHex(later)).toBe(true);
    expect(tsHex(uuidv7(1_700_000_000_000))).toBe(
      (1_700_000_000_000).toString(16).padStart(12, "0"),
    );
  });

  it("is unique across many calls at the same instant", () => {
    const now = 1_700_000_000_000;
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(now)));
    expect(ids.size).toBe(1000);
  });
});
