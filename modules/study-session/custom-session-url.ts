/**
 * Direct study URL presets for the Custom Session setup screen (Phase 14
 * §20/§21, docs/phases/phases-14.md): `/study/custom?collection=bookmarks`
 * and `/study/custom?list=<id>`. Pure: no Dexie, React or DOM imports — the
 * caller (the setup screen) supplies the URL's search params and applies the
 * result to its initial filter state.
 *
 * Only the URL SHAPE is validated here — never whether a list id actually
 * still exists. Existence is deliberately left to the normal collection
 * axis at Start time: an unknown or since-deleted list id simply resolves
 * to zero members (`modules/collections/filters.ts`'s membership lookup is
 * a safe no-op for an unrecognised id), so the existing empty-result guard
 * fires instead of starting an unrestricted session — never a crash, never
 * a silent "all entries" fallback (§21 "a deleted-list URL should not crash
 * or start an unrestricted session").
 */
import {
  OPEN_COLLECTION_FILTER,
  type CollectionFilter,
} from "@/modules/collections/filters";

/**
 * The accepted list-id shape: matches `custom-list-detail.tsx`'s existing
 * defense-in-depth regex for the same reason — it covers real uuidv7 ids
 * (36 lowercase-hex-and-hyphen characters) while rejecting every payload
 * §21 explicitly calls out: arbitrary JSON, comma-separated entry-id lists,
 * component keys (which always contain `:`), filesystem-like paths (`/`,
 * `.`), empty values and overlong values.
 */
const LIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** Validate a candidate list id from a URL query param (§21). */
export function isValidPresetListId(candidate: string): boolean {
  return LIST_ID_PATTERN.test(candidate);
}

/**
 * Parse the `collection`/`list` query params into a `CollectionFilter`. An
 * absent or invalid `collection` value never selects bookmarks; an absent or
 * invalid `list` value never selects a list — both degrade to the neutral,
 * unrestricted axis rather than throwing, so a malformed or hostile URL can
 * never crash the setup screen.
 */
export function parseCollectionPreset(
  params: URLSearchParams,
): CollectionFilter {
  const collectionParam = params.get("collection");
  const listParam = params.get("list");
  return {
    includeBookmarks: collectionParam === "bookmarks",
    listIds:
      listParam !== null && isValidPresetListId(listParam)
        ? [listParam]
        : OPEN_COLLECTION_FILTER.listIds,
  };
}
