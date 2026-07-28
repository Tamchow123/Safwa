/**
 * Phase 17 §12 — the DURABLE guest→account import identity.
 *
 * The import key is the idempotency anchor for the whole merge: the server
 * stores it in `guest_imports` and uses it to decide whether an arriving upload
 * is a fresh import, a retry of one already in progress, or a resubmission of
 * one already applied (§15). For that to work the key must be minted once and
 * survive whatever interrupts the upload — a dropped connection, a reload, a
 * closed tab. So it is written to IndexedDB BEFORE the first network mutation
 * and re-read on every subsequent attempt; a key held only in memory would be
 * regenerated after a crash and the same guest history would import twice.
 *
 * The row is keyed by the TARGET ACCOUNT, because merging the same guest data
 * into two accounts is two independent imports and a key must never be claimed
 * across accounts (§15).
 *
 * Browser-only (Dexie). Randomness and the clock are injected so the behaviour
 * is deterministically testable, mirroring `modules/profile/device.ts`.
 */
import type { GuestImportRecord, SafwaDb } from "@/modules/content/db";

/** Injection seam for the CSPRNG and the clock (tests pass fakes). */
export type GuestImportOptions = {
  /**
   * Must be cryptographically strong (§12). `crypto.randomUUID` is specified to
   * draw from a cryptographically secure source, so 122 random bits make an
   * accidental collision across independent imports negligible — and the server's
   * `UNIQUE (import_key)` makes an unlikely one a loud failure rather than a
   * silent cross-import merge.
   */
  randomUUID?: () => string;
  now?: () => number;
};

function defaultRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/** The import record for `userId`, or `undefined` if none has been claimed. */
export async function readGuestImport(
  db: SafwaDb,
  userId: string,
): Promise<GuestImportRecord | undefined> {
  return db.guestImports.get(userId);
}

/**
 * Get the durable import identity for merging the CURRENT guest snapshot into
 * `userId`, minting and persisting one if needed. Returns the record that is now
 * on disk; the caller may start uploading as soon as it resolves.
 *
 * The four cases, and why each is what it is:
 *
 *   - **No record.** Mint a key, persist it `preparing`. Nothing has been sent.
 *   - **Same snapshot hash, not completed.** Reuse the key VERBATIM, including
 *     `uploadedItems`. This is the retry path §12 requires: the same guest
 *     snapshot must not produce a new key on every request, or each attempt
 *     would look to the server like a separate import of the same history.
 *   - **Same snapshot hash, completed.** Return it untouched. The caller sees
 *     `completed` and treats the merge as already done — "the same import key
 *     with the same snapshot must be a no-op after success" (§12).
 *   - **Different snapshot hash.** The guest's data changed since the key was
 *     bound (they studied more, or an earlier import finished and new data
 *     accumulated). Mint a NEW key rather than resubmitting the old one against
 *     different content, which the server would — correctly — reject as a
 *     payload conflict. Any partial upload under the abandoned key is harmless:
 *     the overlapping attempts and events carry their own ids, so re-sending
 *     them under the new key is an idempotent no-op, and the abandoned key is
 *     recorded in `supersededImportKey` as a local breadcrumb.
 *
 * The whole read-decide-write runs in one `rw` transaction, so two tabs racing
 * to claim the same account's import cannot both mint a key.
 */
export async function claimGuestImport(
  db: SafwaDb,
  userId: string,
  snapshotHash: string,
  options: GuestImportOptions = {},
): Promise<GuestImportRecord> {
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  const now = options.now ?? Date.now;

  return db.transaction("rw", db.guestImports, async () => {
    const existing = await db.guestImports.get(userId);
    if (existing && existing.snapshotHash === snapshotHash) return existing;

    const record: GuestImportRecord = {
      userId,
      importKey: randomUUID(),
      snapshotHash,
      status: "preparing",
      createdAt: now(),
      uploadedItems: 0,
      ...(existing ? { supersededImportKey: existing.importKey } : {}),
    };
    await db.guestImports.put(record);
    return record;
  });
}

/**
 * Every state transition below names the import key it believes it is acting on
 * and is silently dropped when that is no longer the current one.
 *
 * This is not defensive padding: `claimGuestImport` supersedes a key whenever
 * the guest's snapshot changed, so an acknowledgement already in flight under
 * the OLD key can resolve afterwards. Keyed only by account, that stale reply
 * would land on the new record — advancing a resume point past items never sent
 * under it, or reporting a merge complete that never ran. Requiring the key
 * turns a wrong write into a no-op, which is the same treatment the
 * already-`completed` guard gives a late acknowledgement.
 */
function isCurrentImport(
  existing: GuestImportRecord | undefined,
  expectedImportKey: string,
): existing is GuestImportRecord {
  return existing?.importKey === expectedImportKey;
}

/**
 * Record that the upload has begun and how far it has durably got.
 * `uploadedItems` only ever moves FORWARD: a retried chunk that re-reports an
 * earlier position must not rewind the resume point.
 *
 * A no-op unless `expectedImportKey` is still the current one (see above), and a
 * no-op once the import has `completed` — a late chunk acknowledgement arriving
 * after finalisation must not reopen a finished merge.
 */
export async function recordGuestImportProgress(
  db: SafwaDb,
  userId: string,
  expectedImportKey: string,
  uploadedItems: number,
): Promise<void> {
  await db.transaction("rw", db.guestImports, async () => {
    const existing = await db.guestImports.get(userId);
    if (!isCurrentImport(existing, expectedImportKey)) return;
    if (existing.status === "completed") return;
    await db.guestImports.put({
      ...existing,
      status: "uploading",
      uploadedItems: Math.max(existing.uploadedItems, uploadedItems),
    });
  });
}

/**
 * Mark the import durably applied. Terminal: the record is kept (rather than
 * deleted) so a resubmission of the same snapshot is recognised locally as a
 * no-op without a network round trip.
 */
export async function markGuestImportCompleted(
  db: SafwaDb,
  userId: string,
  expectedImportKey: string,
  options: GuestImportOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  await db.transaction("rw", db.guestImports, async () => {
    const existing = await db.guestImports.get(userId);
    if (!isCurrentImport(existing, expectedImportKey)) return;
    await db.guestImports.put({
      ...existing,
      status: "completed",
      completedAt: now(),
    });
  });
}

/**
 * Mark the import failed. NOT terminal and NOT a rollback claim: the key and its
 * progress are retained precisely so the next attempt resumes under the same
 * identity instead of re-importing the history (§29 — once mutation has begun,
 * cancellation must not produce a false rollback claim).
 */
export async function markGuestImportFailed(
  db: SafwaDb,
  userId: string,
  expectedImportKey: string,
): Promise<void> {
  await db.transaction("rw", db.guestImports, async () => {
    const existing = await db.guestImports.get(userId);
    if (!isCurrentImport(existing, expectedImportKey)) return;
    if (existing.status === "completed") return;
    await db.guestImports.put({ ...existing, status: "failed" });
  });
}

/**
 * Discard the import identity for `userId`. Only safe while nothing has been
 * sent — cancelling a still-`preparing` import (§29) — so it refuses once an
 * upload has begun, where forgetting the key would turn the next attempt into a
 * duplicate import rather than a resume. Returns whether the row was removed.
 */
export async function discardGuestImport(
  db: SafwaDb,
  userId: string,
  expectedImportKey: string,
): Promise<boolean> {
  return db.transaction("rw", db.guestImports, async () => {
    const existing = await db.guestImports.get(userId);
    if (!isCurrentImport(existing, expectedImportKey)) return false;
    if (existing.status !== "preparing") return false;
    await db.guestImports.delete(userId);
    return true;
  });
}
