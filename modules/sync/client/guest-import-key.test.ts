import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SafwaDb } from "@/modules/content/db";

import {
  claimGuestImport,
  discardGuestImport,
  markGuestImportCompleted,
  markGuestImportFailed,
  readGuestImport,
  recordGuestImportProgress,
} from "./guest-import-key";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-import-key-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Deterministic stand-ins for the CSPRNG and the clock. */
function fakes(prefix = "key") {
  let issued = 0;
  return {
    randomUUID: () => `${prefix}-${++issued}`,
    now: () => 1_000 + issued,
    issued: () => issued,
  };
}

describe("claimGuestImport", () => {
  it("persists the key BEFORE any network mutation could happen", async () => {
    const f = fakes();
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A, f);

    // Durable already — a crash right here still leaves the identity behind.
    expect(await readGuestImport(db, ACCOUNT)).toEqual(claimed);
    expect(claimed).toMatchObject({
      userId: ACCOUNT,
      importKey: "key-1",
      snapshotHash: HASH_A,
      status: "preparing",
      uploadedItems: 0,
    });
  });

  it("returns the SAME key on a retry of the same snapshot", async () => {
    const f = fakes();
    const first = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    await recordGuestImportProgress(db, ACCOUNT, first.importKey, 40);
    const second = await claimGuestImport(db, ACCOUNT, HASH_A, f);

    expect(second.importKey).toBe(first.importKey);
    // The resume point survives too, so the retry continues rather than restarts.
    expect(second.uploadedItems).toBe(40);
    expect(f.issued()).toBe(1); // no key regenerated per request
  });

  it("reports an already-completed import instead of starting a second one", async () => {
    const f = fakes();
    const first = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    await markGuestImportCompleted(db, ACCOUNT, first.importKey, f);

    const again = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    expect(again.status).toBe("completed");
    expect(again.importKey).toBe(first.importKey);
    expect(f.issued()).toBe(1);
  });

  it("mints a NEW key when the snapshot changed, recording the one it superseded", async () => {
    const f = fakes();
    const first = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    await recordGuestImportProgress(db, ACCOUNT, first.importKey, 40);

    const second = await claimGuestImport(db, ACCOUNT, HASH_B, f);
    expect(second.importKey).not.toBe(first.importKey);
    expect(second.supersededImportKey).toBe(first.importKey);
    expect(second.snapshotHash).toBe(HASH_B);
    // A fresh key starts a fresh upload; the abandoned partial upload is a no-op
    // on re-send because attempts and events carry their own ids.
    expect(second.status).toBe("preparing");
    expect(second.uploadedItems).toBe(0);
  });

  it("keys the import by the TARGET account — one key is never claimed across two", async () => {
    const f = fakes();
    const mine = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    const theirs = await claimGuestImport(db, OTHER, HASH_A, f);

    expect(theirs.importKey).not.toBe(mine.importKey);
    expect((await readGuestImport(db, ACCOUNT))?.importKey).toBe(
      mine.importKey,
    );
  });

  it("uses a cryptographically strong id by default", async () => {
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A);
    // crypto.randomUUID: 122 random bits from a CSPRNG.
    expect(claimed.importKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("progress and terminal states", () => {
  it("never rewinds the resume point when a retried chunk re-reports an earlier position", async () => {
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A, fakes());
    await recordGuestImportProgress(db, ACCOUNT, claimed.importKey, 120);
    await recordGuestImportProgress(db, ACCOUNT, claimed.importKey, 40);

    expect(await readGuestImport(db, ACCOUNT)).toMatchObject({
      status: "uploading",
      uploadedItems: 120,
    });
  });

  it("ignores a late chunk acknowledgement that arrives after completion", async () => {
    const f = fakes();
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    await markGuestImportCompleted(db, ACCOUNT, claimed.importKey, f);
    await recordGuestImportProgress(db, ACCOUNT, claimed.importKey, 999);

    expect(await readGuestImport(db, ACCOUNT)).toMatchObject({
      status: "completed",
      uploadedItems: 0,
    });
  });

  it("keeps the key and its progress on failure so the next attempt RESUMES", async () => {
    const f = fakes();
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    await recordGuestImportProgress(db, ACCOUNT, claimed.importKey, 60);
    await markGuestImportFailed(db, ACCOUNT, claimed.importKey);

    const record = await readGuestImport(db, ACCOUNT);
    expect(record).toMatchObject({
      importKey: claimed.importKey,
      status: "failed",
      uploadedItems: 60,
    });
    // Retrying the same snapshot picks the identity straight back up.
    expect((await claimGuestImport(db, ACCOUNT, HASH_A, f)).importKey).toBe(
      claimed.importKey,
    );
  });

  it("cannot mark a completed import failed", async () => {
    const f = fakes();
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    await markGuestImportCompleted(db, ACCOUNT, claimed.importKey, f);
    await markGuestImportFailed(db, ACCOUNT, claimed.importKey);

    expect((await readGuestImport(db, ACCOUNT))?.status).toBe("completed");
  });
});

describe("a stale acknowledgement from a superseded import (REL-001)", () => {
  /**
   * The interleaving: an upload is under way, the guest studies more, so the
   * next claim supersedes the key — and only THEN does the old key's reply come
   * back. Keyed by account alone it would land on the new record and report
   * progress (or completion) for items that were never sent under it.
   */
  async function supersede() {
    const f = fakes();
    const stale = await claimGuestImport(db, ACCOUNT, HASH_A, f);
    await recordGuestImportProgress(db, ACCOUNT, stale.importKey, 60);
    const current = await claimGuestImport(db, ACCOUNT, HASH_B, f);
    return { f, stale, current };
  }

  it("does not advance the NEW import's resume point", async () => {
    const { stale, current } = await supersede();
    await recordGuestImportProgress(db, ACCOUNT, stale.importKey, 60);

    expect(await readGuestImport(db, ACCOUNT)).toMatchObject({
      importKey: current.importKey,
      status: "preparing",
      uploadedItems: 0,
    });
  });

  it("does not mark the NEW import completed", async () => {
    const { f, stale, current } = await supersede();
    await markGuestImportCompleted(db, ACCOUNT, stale.importKey, f);

    expect(await readGuestImport(db, ACCOUNT)).toMatchObject({
      importKey: current.importKey,
      status: "preparing",
    });
  });

  it("does not mark the NEW import failed", async () => {
    const { stale } = await supersede();
    await markGuestImportFailed(db, ACCOUNT, stale.importKey);

    expect((await readGuestImport(db, ACCOUNT))?.status).toBe("preparing");
  });

  it("does not let a stale cancel discard the NEW import", async () => {
    const { stale, current } = await supersede();
    expect(await discardGuestImport(db, ACCOUNT, stale.importKey)).toBe(false);
    expect((await readGuestImport(db, ACCOUNT))?.importKey).toBe(
      current.importKey,
    );
  });
});

describe("discardGuestImport", () => {
  it("cancels an import that has not sent anything yet", async () => {
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A, fakes());
    expect(await discardGuestImport(db, ACCOUNT, claimed.importKey)).toBe(true);
    expect(await readGuestImport(db, ACCOUNT)).toBeUndefined();
  });

  it("REFUSES once the upload has begun — forgetting the key would duplicate the import", async () => {
    const claimed = await claimGuestImport(db, ACCOUNT, HASH_A, fakes());
    await recordGuestImportProgress(db, ACCOUNT, claimed.importKey, 1);

    expect(await discardGuestImport(db, ACCOUNT, claimed.importKey)).toBe(
      false,
    );
    expect(await readGuestImport(db, ACCOUNT)).toBeDefined();
  });

  it("is a no-op when there is nothing to discard", async () => {
    expect(await discardGuestImport(db, ACCOUNT, "no-such-key")).toBe(false);
  });
});
