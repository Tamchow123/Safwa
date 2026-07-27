/**
 * Pure bookmark record construction (Phase 14, §8.1). A bookmark is
 * identified ONLY by `entryId` — never Arabic surface form, meaning,
 * component key or array position. The id and clock are injected by the
 * persistence adapter; this module never reads the clock or mints an id.
 */
import type { BookmarkRecord } from "@/modules/content/db";
import type { OwnerKey } from "@/modules/content/owner-key";

import { isValidEntryId } from "@/modules/collections/validation";

/**
 * Build a canonical bookmark record for an already-validated entry id. Since
 * schema v7 the OWNER is half of the row's primary key, so it is a required
 * input here rather than something a caller might forget to stamp afterwards.
 */
export function buildBookmarkRecord(
  entryId: number,
  now: number,
  ownerKey: OwnerKey,
): BookmarkRecord {
  if (!isValidEntryId(entryId)) {
    throw new Error(`invalid entry id for bookmark: ${entryId}`);
  }
  return { ownerKey, entryId, createdAt: now };
}
