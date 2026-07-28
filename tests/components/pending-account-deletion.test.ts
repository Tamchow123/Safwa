import { describe, expect, it } from "vitest";

import {
  PENDING_ACCOUNT_DELETION_KEY,
  PENDING_ACCOUNT_DELETION_TTL_MS,
  forgetPendingAccountDeletion,
  newAccountDeletionNonce,
  readPendingAccountDeletion,
  rememberPendingAccountDeletion,
  type LocalStorageLike,
} from "@/components/account/pending-account-deletion";

/** A `Storage`-shaped map, so these tests need no DOM and no global stub. */
function memoryStorage(seed: Record<string, string> = {}): LocalStorageLike {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const NOW = 1_700_000_000_000;
const NONCE = "9d3a1f2c-0000-4000-8000-abcabcabcabc";

describe("the pending-deletion record", () => {
  it("reads back the account when the nonce matches", () => {
    const storage = memoryStorage();
    rememberPendingAccountDeletion("user-1", NONCE, NOW, storage);
    expect(readPendingAccountDeletion(NONCE, NOW, storage)).toBe("user-1");
  });

  it("reads as absent when nothing was ever requested", () => {
    expect(readPendingAccountDeletion(NONCE, NOW, memoryStorage())).toBeNull();
  });

  it("refuses a nonce that does not match, and KEEPS the record", () => {
    // The nonce is the entire proof. A URL carrying someone else's — or a
    // guessed one — must authorise nothing; and it must not be able to destroy
    // a legitimate pending deletion the learner still intends to confirm.
    const storage = memoryStorage();
    rememberPendingAccountDeletion("user-1", NONCE, NOW, storage);
    expect(readPendingAccountDeletion("some-other-nonce", NOW, storage)).toBe(
      null,
    );
    expect(readPendingAccountDeletion(NONCE, NOW, storage)).toBe("user-1");
  });

  it("refuses an empty nonce", () => {
    const storage = memoryStorage();
    rememberPendingAccountDeletion("user-1", "", NOW, storage);
    expect(readPendingAccountDeletion("", NOW, storage)).toBeNull();
  });

  it("mints nonces that are unpredictable and distinct", () => {
    // Derived from the platform CSPRNG, never from the account id or the clock:
    // a guessable value would put the proof back within an attacker's reach.
    const minted = new Set(
      Array.from({ length: 50 }, () => newAccountDeletionNonce()),
    );
    expect(minted.size).toBe(50);
    for (const value of minted) expect(value.length).toBeGreaterThanOrEqual(16);
  });

  it("survives right up to the deletion token's expiry and not past it", () => {
    // The TTL tracks `deleteTokenExpiresIn` in modules/auth/server.ts: once the
    // emailed link can no longer delete anything, a record claiming otherwise
    // is stale authority, not evidence.
    const storage = memoryStorage();
    rememberPendingAccountDeletion("user-1", NONCE, NOW, storage);
    expect(
      readPendingAccountDeletion(
        NONCE,
        NOW + PENDING_ACCOUNT_DELETION_TTL_MS,
        storage,
      ),
    ).toBe("user-1");

    rememberPendingAccountDeletion("user-1", NONCE, NOW, storage);
    expect(
      readPendingAccountDeletion(
        NONCE,
        NOW + PENDING_ACCOUNT_DELETION_TTL_MS + 1,
        storage,
      ),
    ).toBeNull();
  });

  it("treats a record from the future as unusable rather than fresh", () => {
    // A clock that moved backwards would otherwise mint an unbounded lifetime.
    const storage = memoryStorage();
    rememberPendingAccountDeletion("user-1", NONCE, NOW + 60_000, storage);
    expect(readPendingAccountDeletion(NONCE, NOW, storage)).toBeNull();
  });

  it("removes an expired record instead of re-examining it forever", () => {
    const storage = memoryStorage();
    rememberPendingAccountDeletion("user-1", NONCE, NOW, storage);
    readPendingAccountDeletion(
      NONCE,
      NOW + PENDING_ACCOUNT_DELETION_TTL_MS + 1,
      storage,
    );
    expect(storage.getItem(PENDING_ACCOUNT_DELETION_KEY)).toBeNull();
  });

  it.each([
    ["unparseable", "not json at all"],
    ["not an object", '"user-1"'],
    ["missing the account", `{"nonce":"${NONCE}","requestedAtMs":${NOW}}`],
    ["missing the nonce", `{"userId":"user-1","requestedAtMs":${NOW}}`],
    ["missing the timestamp", `{"userId":"user-1","nonce":"${NONCE}"}`],
    [
      "an empty account id",
      `{"userId":"","nonce":"${NONCE}","requestedAtMs":${NOW}}`,
    ],
    ["an empty nonce", `{"userId":"user-1","nonce":"","requestedAtMs":${NOW}}`],
    [
      "a non-numeric timestamp",
      `{"userId":"user-1","nonce":"${NONCE}","requestedAtMs":"yesterday"}`,
    ],
  ])("rejects and removes a %s value", (_label, raw) => {
    // Anything that is not exactly the shape written by
    // rememberPendingAccountDeletion authorises nothing — this value is half of
    // the only thing standing between a URL and a learner's local data.
    const storage = memoryStorage({ [PENDING_ACCOUNT_DELETION_KEY]: raw });
    expect(readPendingAccountDeletion(NONCE, NOW, storage)).toBeNull();
    expect(storage.getItem(PENDING_ACCOUNT_DELETION_KEY)).toBeNull();
  });

  it("forgets on request", () => {
    const storage = memoryStorage();
    rememberPendingAccountDeletion("user-1", NONCE, NOW, storage);
    forgetPendingAccountDeletion(storage);
    expect(readPendingAccountDeletion(NONCE, NOW, storage)).toBeNull();
  });

  it("stays silent when storage is unavailable", () => {
    // Private mode. Every path must degrade to "no record", never to a throw
    // that would break the page it runs on.
    expect(() =>
      rememberPendingAccountDeletion("user-1", NONCE, NOW, null),
    ).not.toThrow();
    expect(readPendingAccountDeletion(NONCE, NOW, null)).toBeNull();
    expect(() => forgetPendingAccountDeletion(null)).not.toThrow();
  });

  it("stays silent when storage throws", () => {
    const throwing: LocalStorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() =>
      rememberPendingAccountDeletion("user-1", NONCE, NOW, throwing),
    ).not.toThrow();
    expect(readPendingAccountDeletion(NONCE, NOW, throwing)).toBeNull();
    expect(() => forgetPendingAccountDeletion(throwing)).not.toThrow();
  });
});
