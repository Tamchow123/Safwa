/**
 * Pure Custom Session collection-axis filtering (Phase 14,
 * docs/phases/phases-14.md §19). No Dexie, React or DOM imports — the
 * caller prepares a `CollectionMembership` snapshot (from
 * `modules/collections/persistence.ts` reads) and passes it in.
 *
 * Collection membership only NARROWS an already-eligible component universe
 * (`deriveAllComponents`); it is applied at the entry level, alongside the
 * bāb/verb-type/book-page axes in `modules/study-session/custom.ts`, and
 * never creates or re-derives a component itself.
 */

/** Prepared bookmark/list membership, ready for pure lookup — no Dexie. */
export type CollectionMembership = {
  bookmarkedEntryIds: ReadonlySet<number>;
  listEntryIdsById: ReadonlyMap<string, ReadonlySet<number>>;
};

/** The neutral membership: matches nothing explicitly (safe when unselected). */
export const EMPTY_COLLECTION_MEMBERSHIP: CollectionMembership = {
  bookmarkedEntryIds: new Set(),
  listEntryIdsById: new Map(),
};

/** The §19 collection-axis selection: bookmarks flag plus selected list ids. */
export type CollectionFilter = {
  includeBookmarks: boolean;
  listIds: readonly string[];
};

/** The neutral starting selection: nothing selected, axis unrestricted. */
export const OPEN_COLLECTION_FILTER: CollectionFilter = {
  includeBookmarks: false,
  listIds: [],
};

/** Whether the collection axis has an explicit (non-empty) selection. */
export function hasCollectionSelection(filter: CollectionFilter): boolean {
  return filter.includeBookmarks || filter.listIds.length > 0;
}

/**
 * Does `entryId` satisfy the collection axis (§19)?
 *
 * - No selection (`includeBookmarks: false`, `listIds: []`) — unrestricted,
 *   every entry matches.
 * - An explicit selection is a UNION across bookmarks and every selected
 *   list: the entry only needs to belong to ONE of them. An explicitly
 *   selected axis that resolves to zero members (e.g. `includeBookmarks:
 *   true` with no bookmarks, or a list id with no resolvable entries)
 *   correctly matches nothing — this function never falls back to "any"
 *   once a selection was made.
 */
export function matchesCollectionFilter(
  entryId: number,
  filter: CollectionFilter,
  membership: CollectionMembership,
): boolean {
  if (!hasCollectionSelection(filter)) return true;
  if (filter.includeBookmarks && membership.bookmarkedEntryIds.has(entryId)) {
    return true;
  }
  return filter.listIds.some((listId) =>
    membership.listEntryIdsById.get(listId)?.has(entryId),
  );
}
