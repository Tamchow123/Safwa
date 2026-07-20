/**
 * Pure Custom Session collection-axis filtering (Phase 14,
 * docs/phases/phases-14.md sections 19/27).
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_COLLECTION_MEMBERSHIP,
  hasCollectionSelection,
  matchesCollectionFilter,
  OPEN_COLLECTION_FILTER,
  type CollectionMembership,
} from "@/modules/collections/filters";

const MEMBERSHIP: CollectionMembership = {
  bookmarkedEntryIds: new Set([1, 2]),
  listEntryIdsById: new Map([
    ["list-a", new Set([2, 3])],
    ["list-b", new Set([4])],
  ]),
};

describe("hasCollectionSelection", () => {
  it("is false for the open (neutral) filter", () => {
    expect(hasCollectionSelection(OPEN_COLLECTION_FILTER)).toBe(false);
  });

  it("is true when bookmarks are included", () => {
    expect(
      hasCollectionSelection({ includeBookmarks: true, listIds: [] }),
    ).toBe(true);
  });

  it("is true when at least one list is selected", () => {
    expect(
      hasCollectionSelection({ includeBookmarks: false, listIds: ["a"] }),
    ).toBe(true);
  });
});

describe("matchesCollectionFilter", () => {
  it("no selection matches every entry regardless of membership", () => {
    expect(
      matchesCollectionFilter(999, OPEN_COLLECTION_FILTER, MEMBERSHIP),
    ).toBe(true);
    expect(
      matchesCollectionFilter(
        999,
        OPEN_COLLECTION_FILTER,
        EMPTY_COLLECTION_MEMBERSHIP,
      ),
    ).toBe(true);
  });

  it("bookmarks-only matches only bookmarked entries", () => {
    const filter = { includeBookmarks: true, listIds: [] };
    expect(matchesCollectionFilter(1, filter, MEMBERSHIP)).toBe(true);
    expect(matchesCollectionFilter(3, filter, MEMBERSHIP)).toBe(false);
  });

  it("a single list matches only that list's entries", () => {
    const filter = { includeBookmarks: false, listIds: ["list-a"] };
    expect(matchesCollectionFilter(2, filter, MEMBERSHIP)).toBe(true);
    expect(matchesCollectionFilter(3, filter, MEMBERSHIP)).toBe(true);
    expect(matchesCollectionFilter(4, filter, MEMBERSHIP)).toBe(false);
  });

  it("multiple lists union", () => {
    const filter = { includeBookmarks: false, listIds: ["list-a", "list-b"] };
    expect(matchesCollectionFilter(3, filter, MEMBERSHIP)).toBe(true);
    expect(matchesCollectionFilter(4, filter, MEMBERSHIP)).toBe(true);
    expect(matchesCollectionFilter(999, filter, MEMBERSHIP)).toBe(false);
  });

  it("bookmarks plus a list union", () => {
    const filter = { includeBookmarks: true, listIds: ["list-b"] };
    expect(matchesCollectionFilter(1, filter, MEMBERSHIP)).toBe(true);
    expect(matchesCollectionFilter(4, filter, MEMBERSHIP)).toBe(true);
    expect(matchesCollectionFilter(3, filter, MEMBERSHIP)).toBe(false);
  });

  it("an explicitly selected empty bookmark set matches nothing via that axis alone", () => {
    const filter = { includeBookmarks: true, listIds: [] };
    expect(
      matchesCollectionFilter(1, filter, EMPTY_COLLECTION_MEMBERSHIP),
    ).toBe(false);
  });

  it("an unknown list id contributes no matches", () => {
    const filter = { includeBookmarks: false, listIds: ["does-not-exist"] };
    expect(matchesCollectionFilter(1, filter, MEMBERSHIP)).toBe(false);
    expect(matchesCollectionFilter(2, filter, MEMBERSHIP)).toBe(false);
  });

  it("stale entry ids in membership never match an entry that is not queried for", () => {
    // Membership may contain ids beyond the active release (§8.5); the
    // predicate is entry-driven, so it is inert for ids never asked about.
    const staleMembership: CollectionMembership = {
      bookmarkedEntryIds: new Set([99999]),
      listEntryIdsById: new Map(),
    };
    expect(
      matchesCollectionFilter(
        1,
        { includeBookmarks: true, listIds: [] },
        staleMembership,
      ),
    ).toBe(false);
  });
});
