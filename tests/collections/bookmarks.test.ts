/**
 * Pure bookmark record construction (Phase 14, docs/phases/phases-14.md
 * sections 8.1/27).
 */
import { describe, expect, it } from "vitest";

import { buildBookmarkRecord } from "@/modules/collections/bookmarks";

describe("buildBookmarkRecord", () => {
  it("uses the injected clock, not the ambient clock", () => {
    const record = buildBookmarkRecord(7, 12_345);
    expect(record).toEqual({ entryId: 7, createdAt: 12_345 });
  });

  it("is a stable, deterministic function of its inputs", () => {
    expect(buildBookmarkRecord(7, 12_345)).toEqual(
      buildBookmarkRecord(7, 12_345),
    );
  });

  it("produces a valid finite integer timestamp", () => {
    const record = buildBookmarkRecord(1, 0);
    expect(Number.isInteger(record.createdAt)).toBe(true);
  });

  it("rejects an invalid entry id", () => {
    expect(() => buildBookmarkRecord(0, 1)).toThrow();
    expect(() => buildBookmarkRecord(-1, 1)).toThrow();
    expect(() => buildBookmarkRecord(1.5, 1)).toThrow();
  });

  it("keeps protected duplicate entries as separate bookmark identities", () => {
    // Protected duplicate-madi group ids (262, 275) - stable entry ids
    // differ, so they must never collapse into one bookmark.
    const first = buildBookmarkRecord(262, 100);
    const second = buildBookmarkRecord(275, 100);
    expect(first.entryId).not.toBe(second.entryId);
  });
});
