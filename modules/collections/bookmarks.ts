/**
 * Pure bookmark record construction (Phase 14, §8.1). A bookmark is
 * identified ONLY by `entryId` — never Arabic surface form, meaning,
 * component key or array position. The id and clock are injected by the
 * persistence adapter; this module never reads the clock or mints an id.
 */
import type { BookmarkRecord } from "@/modules/content/db";

import { isValidEntryId } from "@/modules/collections/validation";

/** Build a canonical bookmark record for an already-validated entry id. */
export function buildBookmarkRecord(
  entryId: number,
  now: number,
): BookmarkRecord {
  if (!isValidEntryId(entryId)) {
    throw new Error(`invalid entry id for bookmark: ${entryId}`);
  }
  return { entryId, createdAt: now };
}
