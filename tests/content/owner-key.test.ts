import { describe, expect, it } from "vitest";

import {
  ACCOUNT_OWNER_KEY_PREFIX,
  accountOwnerKey,
  GUEST_OWNER_KEY,
  InvalidOwnerKeyError,
  isGuestOwnerKey,
  isOwnerKey,
  isValidOwnerAccountId,
  OWNER_ACCOUNT_ID_MAX_LENGTH,
  ownerKeyFromLegacyUserId,
  parseOwnerKey,
  toOwnerKey,
  tryParseOwnerKey,
} from "@/modules/content/owner-key";

const ACCOUNT_ID = "0f1a3c5e-7b9d-4f21-8a6c-2d4e6f8a0b1c";

describe("owner key — construction (phases-17.md §10)", () => {
  it("maps the guest identity to the canonical, non-null guest key", () => {
    expect(GUEST_OWNER_KEY).toBe("guest");
    expect(toOwnerKey(null)).toBe(GUEST_OWNER_KEY);
    // An ABSENT owner is a pre-v6 row, which is a guest row (§10).
    expect(toOwnerKey(undefined)).toBe(GUEST_OWNER_KEY);
    expect(ownerKeyFromLegacyUserId(undefined)).toBe(GUEST_OWNER_KEY);
    expect(ownerKeyFromLegacyUserId(null)).toBe(GUEST_OWNER_KEY);
  });

  it("maps an account id to a prefixed account key", () => {
    expect(toOwnerKey(ACCOUNT_ID)).toBe(`account:${ACCOUNT_ID}`);
    expect(accountOwnerKey(ACCOUNT_ID)).toBe(`account:${ACCOUNT_ID}`);
    expect(ownerKeyFromLegacyUserId(ACCOUNT_ID)).toBe(`account:${ACCOUNT_ID}`);
    expect(ACCOUNT_OWNER_KEY_PREFIX).toBe("account:");
  });

  it("never produces a null/undefined part of a compound key", () => {
    // The whole point of the key: every owner has a TOTAL, non-null,
    // IndexedDB-valid string, so [ownerKey+naturalKey] is always a valid key.
    for (const owner of [null, undefined, ACCOUNT_ID]) {
      const key = toOwnerKey(owner);
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("distinguishes two different accounts and the guest", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    const keys = new Set([
      toOwnerKey(null),
      toOwnerKey(ACCOUNT_ID),
      toOwnerKey(other),
    ]);
    expect(keys.size).toBe(3);
  });

  it("cannot be spoofed by an account id that spells the guest key", () => {
    // "guest" is a legal (if bizarre) account id; it must still key as an
    // ACCOUNT, never collide with the guest identity.
    const key = toOwnerKey("guest");
    expect(key).toBe("account:guest");
    expect(key).not.toBe(GUEST_OWNER_KEY);
    expect(isGuestOwnerKey(key)).toBe(false);
    expect(parseOwnerKey(key)).toBe("guest");
  });
});

describe("owner key — account-id validation", () => {
  it("accepts a normal auth user id", () => {
    expect(isValidOwnerAccountId(ACCOUNT_ID)).toBe(true);
    expect(isValidOwnerAccountId("a")).toBe(true);
    expect(isValidOwnerAccountId("a".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH))).toBe(
      true,
    );
  });

  it("rejects empty, oversized, padded, control-bearing and non-string ids", () => {
    const controlChar = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);
    const nul = String.fromCharCode(0);
    for (const bad of [
      "",
      "a".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH + 1),
      " padded",
      "padded ",
      `has${controlChar}control`,
      `has${del}del`,
      `has${nul}nul`,
      42,
      null,
      undefined,
      {},
      ["x"],
    ]) {
      expect(isValidOwnerAccountId(bad)).toBe(false);
    }
  });

  it("throws rather than minting a key from an invalid account id", () => {
    expect(() => accountOwnerKey("")).toThrow(InvalidOwnerKeyError);
    expect(() => toOwnerKey(" padded")).toThrow(InvalidOwnerKeyError);
    expect(() =>
      toOwnerKey("a".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH + 1)),
    ).toThrow(InvalidOwnerKeyError);
  });
});

describe("owner key — recognition and parsing", () => {
  it("round-trips every owner through build → parse", () => {
    for (const owner of [null, ACCOUNT_ID, "guest", "x"]) {
      expect(parseOwnerKey(toOwnerKey(owner))).toBe(owner);
      expect(tryParseOwnerKey(toOwnerKey(owner))).toBe(owner);
    }
  });

  it("recognises only well-formed keys", () => {
    expect(isOwnerKey(GUEST_OWNER_KEY)).toBe(true);
    expect(isOwnerKey(`account:${ACCOUNT_ID}`)).toBe(true);
    for (const bad of [
      "",
      "guest ",
      "Guest",
      "account:",
      "account: x",
      `account:${"a".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH + 1)}`,
      ACCOUNT_ID, // a bare user id is NOT an owner key
      "user:1",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isOwnerKey(bad)).toBe(false);
    }
  });

  it("tryParse is total for stored values; parse throws for bugs", () => {
    // A corrupted stored row must not throw when merely being read.
    expect(tryParseOwnerKey("account:")).toBeUndefined();
    expect(tryParseOwnerKey(ACCOUNT_ID)).toBeUndefined();
    expect(tryParseOwnerKey(undefined)).toBeUndefined();
    // ... but a code path that requires a valid key fails loudly.
    expect(() => parseOwnerKey("account:")).toThrow(InvalidOwnerKeyError);
    expect(() => parseOwnerKey(ACCOUNT_ID)).toThrow(InvalidOwnerKeyError);
  });

  it("guest detection is exact", () => {
    expect(isGuestOwnerKey(GUEST_OWNER_KEY)).toBe(true);
    expect(isGuestOwnerKey(toOwnerKey(ACCOUNT_ID))).toBe(false);
  });
});
