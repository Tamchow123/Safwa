/**
 * Pure custom-list record construction (Phase 14, §6/§8.2/§8.4). Every
 * builder takes an injected id and clock instant — this module never mints
 * a UUID (`lib/uuid.ts` is the impure boundary) or reads the clock, so a
 * fixed set of inputs always produces the exact same record.
 */
import type { CustomListRecord } from "@/modules/content/db";

import {
  canonicaliseMembership,
  cleanListNameInput,
} from "@/modules/collections/validation";

/** Build a new, canonical custom-list record. */
export function buildListRecord(params: {
  id: string;
  name: string;
  entryIds?: readonly number[];
  now: number;
}): CustomListRecord {
  const { id, name, entryIds = [], now } = params;
  return {
    id,
    name: cleanListNameInput(name),
    entryIds: canonicaliseMembership(entryIds),
    createdAt: now,
    updatedAt: now,
  };
}

/** A renamed copy of `list`, cleaned display name, `updatedAt` bumped. */
export function withRenamedList(
  list: CustomListRecord,
  name: string,
  now: number,
): CustomListRecord {
  return { ...list, name: cleanListNameInput(name), updatedAt: now };
}

/** A copy of `list` with canonicalised membership, `updatedAt` bumped. */
export function withMembership(
  list: CustomListRecord,
  entryIds: readonly number[],
  now: number,
): CustomListRecord {
  return {
    ...list,
    entryIds: canonicaliseMembership(entryIds),
    updatedAt: now,
  };
}

/** Idempotent add: adding an already-present entry changes nothing but `updatedAt`. */
export function withEntryAdded(
  list: CustomListRecord,
  entryId: number,
  now: number,
): CustomListRecord {
  return withMembership(list, [...list.entryIds, entryId], now);
}

/** Idempotent remove: removing a missing entry changes nothing but `updatedAt`. */
export function withEntryRemoved(
  list: CustomListRecord,
  entryId: number,
  now: number,
): CustomListRecord {
  return withMembership(
    list,
    list.entryIds.filter((id) => id !== entryId),
    now,
  );
}
