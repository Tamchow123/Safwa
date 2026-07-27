/**
 * The canonical LOCAL OWNER KEY (Phase 17, phases-17.md §10) — the single
 * builder/parser for the identity half of every owner-scoped Dexie key.
 *
 * Phase 16 (schema v6) gave the private learner-state stores a `userId` owner
 * column (`null`/absent = guest) but LEFT their primary keys alone, so an
 * account write could still physically replace a guest's row sharing the same
 * natural key (`componentKey`, `entryId`, `key`). Phase 17 promotes the owner
 * into the primary key itself. IndexedDB cannot index `null`, and a compound
 * key containing `null`/`undefined` is not a valid key at all, so the owner
 * cannot simply be the nullable `userId`: it must be a TOTAL, non-null,
 * IndexedDB-valid value. That value is this module's `OwnerKey`:
 *
 *     guest                  — the un-signed-in learner on this device
 *     account:<user-id>      — the signed-in account with that id
 *
 * The string is opaque to consumers: build it with {@link toOwnerKey} (or
 * {@link GUEST_OWNER_KEY}) and read it back with {@link parseOwnerKey} /
 * {@link tryParseOwnerKey}. Nothing else may concatenate or slice the prefix —
 * that is exactly the "do not scatter ad hoc compound-key construction across
 * components" rule (§10), and the branded type makes an accidental raw user id
 * a compile error rather than a silently mis-scoped row.
 *
 * PURE: no Dexie, React, DOM or database imports (the only import is the
 * `LocalOwnerId` TYPE from the schema owner, erased at runtime) — it is
 * imported by `modules/content/db.ts`, by every persistence adapter and by the
 * merge pipeline, so it must stay dependency-free.
 */

import type { LocalOwnerId } from "@/modules/content/db";

/**
 * A validated local owner key. Branded so a raw `string` (a user id, a natural
 * key, a value read from an untrusted source) cannot be passed where an owner
 * key is required without going through {@link toOwnerKey} / {@link isOwnerKey}.
 * At runtime it is just the string described above.
 */
export type OwnerKey = string & { readonly __ownerKey: unique symbol };

/** The owner key of the guest (not signed in) identity on this device. */
export const GUEST_OWNER_KEY = "guest" as OwnerKey;

/** Prefix of every signed-in account's owner key. */
export const ACCOUNT_OWNER_KEY_PREFIX = "account:";

/**
 * Maximum accepted account-id length. Better Auth is configured with
 * `generateId: "uuid"` (db/schema/auth.ts), so real ids are 36 characters; the
 * bound is deliberately generous but finite so a malformed or hostile value can
 * never become an unbounded IndexedDB key.
 */
export const OWNER_ACCOUNT_ID_MAX_LENGTH = 64;

/**
 * Whether `value` contains a C0 control character or DEL. Checked by code
 * point rather than a regular expression so no literal control character ever
 * appears in this source file (the repository keeps such checks ASCII-safe).
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Thrown when a value cannot be a valid owner key / account id. */
export class InvalidOwnerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOwnerKeyError";
  }
}

/**
 * Whether `value` is usable as the account half of an owner key. Deliberately
 * NOT a UUID test: the id comes from the auth provider, and pinning the local
 * key format to today's `generateId` choice would turn a future provider
 * configuration change into a hard local-write failure. What matters for a
 * durable IndexedDB key is that the value is a non-empty, bounded string with
 * no control characters and no surrounding whitespace (which would make two
 * spellings of one identity compare unequal) — anything else is rejected.
 */
export function isValidOwnerAccountId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= OWNER_ACCOUNT_ID_MAX_LENGTH &&
    !hasControlCharacter(value) &&
    value.trim() === value
  );
}

/**
 * The owner key for a local owner: the guest key for `null`/absent, or
 * `account:<user-id>` for a signed-in account. Throws
 * {@link InvalidOwnerKeyError} rather than minting an unusable key — a write
 * stamped with a malformed identity is exactly the silent mis-scoping this
 * module exists to prevent.
 */
export function toOwnerKey(owner: LocalOwnerId | undefined): OwnerKey {
  if (owner === null || owner === undefined) return GUEST_OWNER_KEY;
  return accountOwnerKey(owner);
}

/** The owner key of a signed-in account id (never the guest key). */
export function accountOwnerKey(userId: string): OwnerKey {
  if (!isValidOwnerAccountId(userId)) {
    throw new InvalidOwnerKeyError("invalid account id for an owner key");
  }
  return `${ACCOUNT_OWNER_KEY_PREFIX}${userId}` as OwnerKey;
}

/** Runtime guard for a stored value that claims to be an owner key. */
export function isOwnerKey(value: unknown): value is OwnerKey {
  if (typeof value !== "string") return false;
  if (value === GUEST_OWNER_KEY) return true;
  if (!value.startsWith(ACCOUNT_OWNER_KEY_PREFIX)) return false;
  return isValidOwnerAccountId(value.slice(ACCOUNT_OWNER_KEY_PREFIX.length));
}

/** Whether `key` denotes the guest identity. */
export function isGuestOwnerKey(key: OwnerKey): boolean {
  return key === GUEST_OWNER_KEY;
}

/**
 * The {@link LocalOwnerId} an owner key denotes (`null` for the guest), or
 * `undefined` when the value is not a valid owner key. TOTAL — use this for
 * values read back out of storage, where a corrupt row must not throw.
 */
export function tryParseOwnerKey(value: unknown): LocalOwnerId | undefined {
  if (!isOwnerKey(value)) return undefined;
  return value === GUEST_OWNER_KEY
    ? null
    : value.slice(ACCOUNT_OWNER_KEY_PREFIX.length);
}

/**
 * The {@link LocalOwnerId} an owner key denotes (`null` for the guest).
 * Throws {@link InvalidOwnerKeyError} for anything that is not a valid owner
 * key — use it where a malformed key means a bug, not merely bad stored data.
 */
export function parseOwnerKey(value: unknown): LocalOwnerId {
  if (!isOwnerKey(value)) {
    throw new InvalidOwnerKeyError("value is not a valid owner key");
  }
  return value === GUEST_OWNER_KEY
    ? null
    : value.slice(ACCOUNT_OWNER_KEY_PREFIX.length);
}

/**
 * The owner key of a row stored under the SCHEMA v6 contract, where the owner
 * was the nullable `userId` column and an ABSENT value meant "guest" (a pre-v6
 * row predating the column). The v7 data-moving migration and any remaining
 * legacy read path funnel through here, so that "absent and null both mean
 * guest" keeps living in exactly one place.
 */
export function ownerKeyFromLegacyUserId(
  userId: string | null | undefined,
): OwnerKey {
  return toOwnerKey(userId ?? null);
}
