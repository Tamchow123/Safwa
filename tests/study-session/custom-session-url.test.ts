import { describe, expect, it } from "vitest";

import { OPEN_COLLECTION_FILTER } from "@/modules/collections/filters";
import {
  isValidPresetListId,
  parseCollectionPreset,
} from "@/modules/study-session/custom-session-url";

describe("parseCollectionPreset (Phase 14 §20/§21)", () => {
  it("returns the open (unrestricted) filter when no preset params are present", () => {
    expect(parseCollectionPreset(new URLSearchParams())).toEqual(
      OPEN_COLLECTION_FILTER,
    );
  });

  it("selects bookmarks only for the exact value 'bookmarks'", () => {
    const preset = parseCollectionPreset(
      new URLSearchParams("collection=bookmarks"),
    );
    expect(preset.includeBookmarks).toBe(true);
    expect(preset.listIds).toEqual([]);
  });

  it("ignores an unrecognised collection value rather than selecting bookmarks", () => {
    for (const value of ["true", "1", "all", "Bookmarks", ""]) {
      const preset = parseCollectionPreset(
        new URLSearchParams(`collection=${encodeURIComponent(value)}`),
      );
      expect(preset.includeBookmarks).toBe(false);
    }
  });

  it("selects a well-formed list id (uuidv7 shape)", () => {
    const listId = "018f4b1a-2c3d-7e4f-9a1b-0123456789ab";
    const preset = parseCollectionPreset(
      new URLSearchParams(`list=${encodeURIComponent(listId)}`),
    );
    expect(preset.listIds).toEqual([listId]);
    expect(preset.includeBookmarks).toBe(false);
  });

  it("combines a bookmarks selection with a list selection (union axis, §19)", () => {
    const listId = "my-list-1";
    const preset = parseCollectionPreset(
      new URLSearchParams(`collection=bookmarks&list=${listId}`),
    );
    expect(preset.includeBookmarks).toBe(true);
    expect(preset.listIds).toEqual([listId]);
  });

  it("rejects every payload shape §21 explicitly calls out", () => {
    const rejected = [
      '{"a":1}', // arbitrary JSON
      "1,2,3", // comma-separated entry id payload
      "entry:1:skill:bab_identification", // component key
      "../../etc/passwd", // filesystem-like path
      "a/b", // path separator
      "", // empty
      "a".repeat(101), // overlong
    ];
    for (const candidate of rejected) {
      expect(isValidPresetListId(candidate)).toBe(false);
      const preset = parseCollectionPreset(
        new URLSearchParams({ list: candidate }),
      );
      expect(preset.listIds).toEqual([]);
    }
  });

  it("accepts a value at exactly the length boundary and rejects one over it", () => {
    expect(isValidPresetListId("a".repeat(100))).toBe(true);
    expect(isValidPresetListId("a".repeat(101))).toBe(false);
  });

  it("never throws for a missing list param", () => {
    expect(() => parseCollectionPreset(new URLSearchParams())).not.toThrow();
  });
});
