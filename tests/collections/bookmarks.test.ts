/**
 * Pure bookmark record construction (Phase 14, docs/phases/phases-14.md
 * sections 8.1/27).
 */
import { describe, expect, it } from "vitest";

import { buildBookmarkRecord } from "@/modules/collections/bookmarks";
import { GUEST_OWNER_KEY } from "@/modules/content/owner-key";

describe("buildBookmarkRecord", () => {
  it("uses the injected clock, not the ambient clock", () => {
    const record = buildBookmarkRecord(7, 12_345, GUEST_OWNER_KEY);
    expect(record).toEqual({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 7,
      createdAt: 12_345,
    });
  });

  it("is a stable, deterministic function of its inputs", () => {
    expect(buildBookmarkRecord(7, 12_345, GUEST_OWNER_KEY)).toEqual(
      buildBookmarkRecord(7, 12_345, GUEST_OWNER_KEY),
    );
  });

  it("produces a valid finite integer timestamp", () => {
    const record = buildBookmarkRecord(1, 0, GUEST_OWNER_KEY);
    expect(Number.isInteger(record.createdAt)).toBe(true);
  });

  it("rejects an invalid entry id", () => {
    expect(() => buildBookmarkRecord(0, 1, GUEST_OWNER_KEY)).toThrow();
    expect(() => buildBookmarkRecord(-1, 1, GUEST_OWNER_KEY)).toThrow();
    expect(() => buildBookmarkRecord(1.5, 1, GUEST_OWNER_KEY)).toThrow();
  });

  it("keeps protected duplicate entries as separate bookmark identities", () => {
    // Protected duplicate-madi group ids (262, 275) - stable entry ids
    // differ, so they must never collapse into one bookmark.
    const first = buildBookmarkRecord(262, 100, GUEST_OWNER_KEY);
    const second = buildBookmarkRecord(275, 100, GUEST_OWNER_KEY);
    expect(first.entryId).not.toBe(second.entryId);
  });
});
