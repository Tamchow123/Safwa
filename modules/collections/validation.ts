/**
 * Pure validation and canonicalisation for bookmarks and custom lists
 * (Phase 14, docs/phases/phases-14.md §8). No Dexie, React or DOM imports —
 * every impure boundary (id generation, the clock, Dexie reads/writes) is
 * injected by callers in `modules/collections/persistence.ts`.
 */

/** §8.3 list-name policy. */
export const LIST_NAME_MIN_LENGTH = 1;
export const LIST_NAME_MAX_LENGTH = 60;
/** §8.3 max lists policy. */
export const MAX_LISTS = 50;

export type ListNameValidationResult =
  | { valid: true; displayName: string; normalisedName: string }
  | { valid: false; reason: "empty" | "too_long" };

/**
 * Clean a raw list-name input for DISPLAY: Unicode NFC normalise, trim
 * leading/trailing whitespace, collapse internal whitespace runs to one
 * ordinary space. Preserves the learner's entered casing.
 */
export function cleanListNameInput(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * The case-insensitive comparison key for a list name (§8.3): the cleaned
 * display form, lower-cased. Locale-independent (`toLowerCase()`, not
 * `toLocaleLowerCase()`) so two browsers never disagree on a collision.
 */
export function normaliseListNameForComparison(raw: string): string {
  return cleanListNameInput(raw).toLowerCase();
}

/** Validate a raw list-name input against the length policy (§8.3). */
export function validateListName(raw: string): ListNameValidationResult {
  const displayName = cleanListNameInput(raw);
  if (displayName.length < LIST_NAME_MIN_LENGTH) {
    return { valid: false, reason: "empty" };
  }
  if (displayName.length > LIST_NAME_MAX_LENGTH) {
    return { valid: false, reason: "too_long" };
  }
  return {
    valid: true,
    displayName,
    normalisedName: normaliseListNameForComparison(raw),
  };
}

/**
 * Does `name` collide (case-insensitively, after cleaning) with an existing
 * list? `excludeListId` lets a rename retain the list's own current name
 * (§8.3: "A rename may retain the same list's current normalised name").
 */
export function isDuplicateListName(
  name: string,
  existingLists: readonly { id: string; name: string }[],
  excludeListId?: string,
): boolean {
  const normalised = normaliseListNameForComparison(name);
  return existingLists.some(
    (list) =>
      list.id !== excludeListId &&
      normaliseListNameForComparison(list.name) === normalised,
  );
}

/** Whether one more list may be created under the §8.3 max-lists policy. */
export function canCreateAnotherList(existingListCount: number): boolean {
  return existingListCount < MAX_LISTS;
}

/** A valid, storable entry id: a finite positive integer (§8.1/§8.4). */
export function isValidEntryId(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Canonicalise a list's entry-id membership (§6/§8.4): reject invalid ids,
 * deduplicate, sort numerically ascending. Insertion order is never
 * meaningful for identity or equality.
 */
export function canonicaliseMembership(entryIds: readonly number[]): number[] {
  const valid = entryIds.filter(isValidEntryId);
  return Array.from(new Set(valid)).sort((a, b) => a - b);
}

/**
 * Narrow a stored membership array to only the ids the currently active
 * verified learner release can resolve (§8.5/§23). The raw stored array is
 * never mutated by this — callers keep the full stored record and use this
 * result only for learner-facing views and study plans.
 */
export function resolvableMembership(
  entryIds: readonly number[],
  knownEntryIds: ReadonlySet<number>,
): number[] {
  return entryIds.filter((id) => knownEntryIds.has(id));
}

/** A finite non-negative integer epoch-ms timestamp (§6). */
export function isValidTimestamp(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
