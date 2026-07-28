/**
 * Owner-scoped reads over the private learner-state stores (schema v7,
 * phases-17.md §10). Every such store carries an indexed `ownerKey`
 * (`modules/content/owner-key.ts`) — for four of them it is even half of the
 * primary key — so a signed-in account never READS, extends or overwrites a
 * guest's (or another account's) rows that share the same natural key.
 *
 * Since v7 the owner key is a TOTAL, non-null value, so a guest's rows are
 * indexed exactly like an account's: the v6-era split (IndexedDB cannot index
 * `null`, so guest reads had to scan the whole store and filter in memory) is
 * gone, and with it the class of bugs where one identity's read accidentally saw
 * another's rows.
 *
 * Browser-only (Dexie), pure aside from the passed-in table read.
 */
import type { Table } from "dexie";

import type { LocalOwnerId } from "@/modules/content/db";
import { toOwnerKey, type OwnerKey } from "@/modules/content/owner-key";

/** A row of any owner-scoped store. */
type OwnedRow = { ownerKey: OwnerKey };

/**
 * True when two stored owner keys denote the SAME local identity. Kept as a
 * named helper so the comparison has one home even though the v7 key makes it a
 * plain string equality (there is no longer an absent-vs-null case to reconcile).
 */
export function sameOwnerKey(a: OwnerKey, b: OwnerKey): boolean {
  return a === b;
}

/**
 * THE compound primary key of an owner-keyed row: `[ownerKey, naturalKey]`
 * (phases-17.md §10 — "do not scatter ad hoc compound-key construction across
 * components; provide one shared builder/parser owned by the persistence
 * layer"). Every `.get()`, `.delete()` and `.equals()` against one of the four
 * owner-keyed stores goes through here rather than assembling the array inline,
 * so the owner half can never be forgotten, mis-encoded from a raw `LocalOwnerId`
 * or transposed with the natural key at a call site.
 *
 * The natural key is generic because the stores differ (`componentKey` and a
 * setting `key` are strings, a bookmark's `entryId` is a number, a daily-activity
 * row's `localDate` is a string).
 */
export function ownedKey<K extends string | number>(
  owner: LocalOwnerId,
  naturalKey: K,
): [OwnerKey, K] {
  return [toOwnerKey(owner), naturalKey];
}

/**
 * All rows of `table` OWNED BY `owner`, read through the indexed `ownerKey`.
 * Works identically for a guest and for an account — the guest key is a real,
 * indexable value.
 */
export async function readOwnedRows<T extends OwnedRow, TKey, TInsert>(
  table: Table<T, TKey, TInsert>,
  owner: LocalOwnerId,
): Promise<T[]> {
  return table.where("ownerKey").equals(toOwnerKey(owner)).toArray();
}

/**
 * Delete every row of `table` owned by `owner`. The owner-scoped counterpart of
 * a whole-store `clear()`: sign-out removes the departing account's rows while
 * a coexisting guest's (or another account's) rows are left untouched
 * (phases-17.md §11). Must run inside the caller's `rw` transaction so the whole
 * cleanup commits or rolls back together.
 */
export async function deleteOwnedRows<T extends OwnedRow, TKey, TInsert>(
  table: Table<T, TKey, TInsert>,
  owner: LocalOwnerId,
): Promise<number> {
  return table.where("ownerKey").equals(toOwnerKey(owner)).delete();
}
