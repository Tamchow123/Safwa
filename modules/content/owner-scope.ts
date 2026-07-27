/**
 * Local-owner scoping helpers (schema v6, R2-F3). The private learner-state
 * stores (study_components, review_events, bookmarks, lists, settings) each
 * carry a `userId` owner (`null`/absent = guest; a real string = a signed-in
 * account). A signed-in account must never READ, extend or overwrite a guest's
 * (or another account's) rows that share the same natural key — so every scoped
 * read/write funnels the owner comparison through here, keeping the "absent and
 * null both mean guest" rule in ONE place.
 *
 * IndexedDB CANNOT index `null`, so the two owner kinds take different paths:
 *   - a real account id uses the store's `userId` (or `[userId+…]`) index;
 *   - a guest (null) scans the natural-key index and filters in memory, because
 *     no index entry exists for a null/absent `userId`.
 * `readOwnedRows` encapsulates that split so callers never re-derive it.
 *
 * Browser-only (Dexie), pure aside from the passed-in table read.
 */
import type { EntityTable } from "dexie";

import type { LocalOwnerId } from "@/modules/content/db";

/**
 * True when two stored owner ids denote the SAME local identity — both a `null`
 * and an absent (pre-v6) owner mean "guest", so they compare equal (R2-F3).
 */
export function sameOwner(
  a: LocalOwnerId | undefined,
  b: LocalOwnerId | undefined,
): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * All rows of `table` OWNED BY `owner`. A real account id narrows on the
 * indexed `userId` column; a guest (null) cannot (IndexedDB won't index null),
 * so it reads the whole store and keeps only the un-owned rows in memory. The
 * table row type must expose the optional `userId` owner column.
 */
export async function readOwnedRows<
  T extends { userId?: LocalOwnerId },
  IdProp extends keyof T & string,
>(table: EntityTable<T, IdProp>, owner: LocalOwnerId): Promise<T[]> {
  if (owner === null) {
    return (await table.toArray()).filter(
      (row) => (row.userId ?? null) === null,
    );
  }
  return table.where("userId").equals(owner).toArray();
}
