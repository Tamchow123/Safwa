import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forgetLastKnownOwner,
  LAST_KNOWN_OWNER_STORAGE_KEY,
  readLastKnownOwner,
  rememberLastKnownOwner,
  type LastKnownOwnerStorage,
} from "@/modules/auth/last-known-owner";
import { OWNER_ACCOUNT_ID_MAX_LENGTH } from "@/modules/content/owner-key";

const ACCOUNT_ID = "9f1c4d2e-7a3b-4c5d-8e6f-0a1b2c3d4e5f";
const OTHER_ACCOUNT_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** An in-memory Storage stand-in — no jsdom globals, no cross-test bleed. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    // Test-only introspection, deliberately not part of the module's type.
    snapshot: () => Object.fromEntries(map),
  };
}

/** A Storage whose every operation throws — Safari private mode, quota, etc. */
const hostileStorage: LastKnownOwnerStorage = {
  getItem() {
    throw new DOMException("SecurityError");
  },
  setItem() {
    throw new DOMException("QuotaExceededError");
  },
  removeItem() {
    throw new DOMException("SecurityError");
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the storage key", () => {
  it("is namespaced and version-tagged", () => {
    // The version lives in the KEY, so a future format change is a new key
    // rather than a parser that must tolerate two shapes.
    expect(LAST_KNOWN_OWNER_STORAGE_KEY).toBe("safwa.last-known-owner.v1");
  });
});

describe("remember then read — the round trip that carries an offline boot", () => {
  it("returns what was remembered", () => {
    const storage = fakeStorage();
    rememberLastKnownOwner(ACCOUNT_ID, storage);
    expect(readLastKnownOwner(storage)).toBe(ACCOUNT_ID);
  });

  it("stores the bare id under the key, with no envelope", () => {
    const storage = fakeStorage();
    rememberLastKnownOwner(ACCOUNT_ID, storage);
    expect(storage.snapshot()).toEqual({
      [LAST_KNOWN_OWNER_STORAGE_KEY]: ACCOUNT_ID,
    });
  });

  it("replaces a previous owner rather than accumulating", () => {
    const storage = fakeStorage();
    rememberLastKnownOwner(ACCOUNT_ID, storage);
    rememberLastKnownOwner(OTHER_ACCOUNT_ID, storage);
    expect(readLastKnownOwner(storage)).toBe(OTHER_ACCOUNT_ID);
  });

  it("reads nothing when nothing was ever remembered", () => {
    expect(readLastKnownOwner(fakeStorage())).toBeNull();
  });

  it("has no TTL: an ancient value is still returned", () => {
    // The memory is bounded by an explicit forget on an identity change, not
    // by a clock (§2.1). Simulate a value written long ago by seeding storage
    // directly and advancing the clock a year.
    const storage = fakeStorage({
      [LAST_KNOWN_OWNER_STORAGE_KEY]: ACCOUNT_ID,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2027-07-29T00:00:00Z"));
      expect(readLastKnownOwner(storage)).toBe(ACCOUNT_ID);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("forget", () => {
  it("removes the memory", () => {
    const storage = fakeStorage();
    rememberLastKnownOwner(ACCOUNT_ID, storage);
    forgetLastKnownOwner(storage);
    expect(readLastKnownOwner(storage)).toBeNull();
    expect(storage.snapshot()).toEqual({});
  });

  it("is idempotent and safe with nothing stored", () => {
    const storage = fakeStorage();
    expect(() => {
      forgetLastKnownOwner(storage);
      forgetLastKnownOwner(storage);
    }).not.toThrow();
  });

  it("leaves unrelated keys alone", () => {
    // Sign-out clears several localStorage mirrors; this one must only ever
    // touch its own key.
    const storage = fakeStorage({
      theme: "dark",
      [LAST_KNOWN_OWNER_STORAGE_KEY]: ACCOUNT_ID,
      "safwa.arabic-font-scale": "1.2",
    });
    forgetLastKnownOwner(storage);
    expect(storage.snapshot()).toEqual({
      theme: "dark",
      "safwa.arabic-font-scale": "1.2",
    });
  });
});

describe("a stored value is re-validated, never trusted", () => {
  const corrupt: ReadonlyArray<{ name: string; value: string }> = [
    { name: "an empty string", value: "" },
    { name: "a whitespace-padded id", value: ` ${ACCOUNT_ID} ` },
    { name: "a trailing newline", value: `${ACCOUNT_ID}\n` },
    {
      name: "an over-length value",
      value: "x".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH + 1),
    },
    // Written as an ESCAPE, never as a literal control character: this
    // repository keeps such checks ASCII-safe in source (owner-key.ts).
    {
      name: "a value containing a control character",
      value: "abc\u0007def",
    },
  ];

  for (const { name, value } of corrupt) {
    it(`reads ${name} as no memory at all`, () => {
      const storage = fakeStorage({ [LAST_KNOWN_OWNER_STORAGE_KEY]: value });
      expect(readLastKnownOwner(storage)).toBeNull();
    });
  }

  it("accepts a value at exactly the maximum length", () => {
    const id = "x".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH);
    const storage = fakeStorage({ [LAST_KNOWN_OWNER_STORAGE_KEY]: id });
    expect(readLastKnownOwner(storage)).toBe(id);
  });

  it("does NOT add a second, stricter notion of a valid account id", () => {
    // Deliberate, and worth stating because it looks like a gap: a short
    // implausible-looking string such as "{}" round-trips, because
    // isValidOwnerAccountId is deliberately NOT a UUID test — owner-key.ts
    // explains that pinning the local key format to today's `generateId`
    // choice would turn a future auth-provider configuration change into a
    // hard local-write failure. Tightening it HERE would create exactly the
    // second definition of "a usable account id" that hard rule 8 exists to
    // prevent, and would do so in only one of the several places that
    // validate one. It is also not a security boundary: the server derives
    // the account from the session and never trusts a client-supplied owner
    // (hard rule 7), so a tampered local value can only mis-scope that
    // device's own view, never reach another account's data.
    const storage = fakeStorage({ [LAST_KNOWN_OWNER_STORAGE_KEY]: "{}" });
    expect(readLastKnownOwner(storage)).toBe("{}");
  });

  it("leaves an invalid value in place rather than deleting it on a read", () => {
    // Documented behaviour: the value is already inert (it reads as null), so
    // a read path does not take on a write and its extra failure mode.
    const storage = fakeStorage({ [LAST_KNOWN_OWNER_STORAGE_KEY]: "" });
    readLastKnownOwner(storage);
    expect(storage.snapshot()).toEqual({ [LAST_KNOWN_OWNER_STORAGE_KEY]: "" });
  });
});

describe("an unusable id is refused on write, never stored", () => {
  const unusable = [
    "",
    "  ",
    ` ${ACCOUNT_ID}`,
    "x".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH + 1),
  ];

  for (const value of unusable) {
    it(`refuses ${JSON.stringify(value.slice(0, 24))}`, () => {
      const storage = fakeStorage();
      rememberLastKnownOwner(value, storage);
      expect(storage.snapshot()).toEqual({});
    });
  }

  it("refuses a non-string that slipped past the type system", () => {
    const storage = fakeStorage();
    rememberLastKnownOwner(12345 as unknown as string, storage);
    expect(storage.snapshot()).toEqual({});
  });

  it("does not clobber a good memory with a bad write", () => {
    // A refused write must be a no-op, not a reset: the previous, valid owner
    // is still the best answer available on an offline boot.
    const storage = fakeStorage();
    rememberLastKnownOwner(ACCOUNT_ID, storage);
    rememberLastKnownOwner("", storage);
    expect(readLastKnownOwner(storage)).toBe(ACCOUNT_ID);
  });
});

describe("storage that is unavailable or hostile", () => {
  it("degrades to no memory when storage is absent", () => {
    expect(readLastKnownOwner(null)).toBeNull();
    expect(() => rememberLastKnownOwner(ACCOUNT_ID, null)).not.toThrow();
    expect(() => forgetLastKnownOwner(null)).not.toThrow();
    expect(rememberLastKnownOwner(ACCOUNT_ID, null)).toBe(false);
    expect(forgetLastKnownOwner(null)).toBe(false);
  });

  it("swallows a throwing getItem (sandboxed iframe / blocked storage)", () => {
    expect(readLastKnownOwner(hostileStorage)).toBeNull();
  });

  it("swallows a throwing setItem (Safari private mode, quota exceeded)", () => {
    // Remembering is an optimisation; a sign-in must not fail because of it.
    expect(() =>
      rememberLastKnownOwner(ACCOUNT_ID, hostileStorage),
    ).not.toThrow();
    expect(rememberLastKnownOwner(ACCOUNT_ID, hostileStorage)).toBe(false);
  });

  it("swallows a throwing removeItem so sign-out can never fail here", () => {
    expect(() => forgetLastKnownOwner(hostileStorage)).not.toThrow();
    expect(forgetLastKnownOwner(hostileStorage)).toBe(false);
  });
});

describe("the result is read back, not inferred from 'it did not throw'", () => {
  it("reports success when the memory really is in place / really is gone", () => {
    const storage = fakeStorage();
    expect(rememberLastKnownOwner(ACCOUNT_ID, storage)).toBe(true);
    expect(forgetLastKnownOwner(storage)).toBe(true);
  });

  it("neutralises the value when the delete is a silent no-op", () => {
    // A repeat `removeItem` would do the same nothing, so forget falls back to
    // a DIFFERENT operation: writing an empty string, which can never be a
    // valid owner account id and so reads as no memory at all. This is what
    // makes the failure recoverable rather than merely reported.
    const map = new Map<string, string>([
      [LAST_KNOWN_OWNER_STORAGE_KEY, ACCOUNT_ID],
    ]);
    const undeletable: LastKnownOwnerStorage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: () => {
        // Accepts the call and does nothing — the failure an exception-only
        // check cannot see.
      },
    };

    expect(forgetLastKnownOwner(undeletable)).toBe(true);
    expect(readLastKnownOwner(undeletable)).toBeNull();
    // The key may still exist; what matters is that no reader can get an owner
    // out of it.
    expect(map.get(LAST_KNOWN_OWNER_STORAGE_KEY)).toBe("");
  });

  it("reports failure when neither the delete nor the neutralising write takes", () => {
    // A store that accepts every mutation and honours none. Both avenues are
    // exhausted, so `false` here is the honest answer rather than a missing
    // attempt — and on a shared device that surviving owner is what the NEXT
    // person's offline writes would be stamped with.
    const amnesiac: LastKnownOwnerStorage = {
      getItem: () => ACCOUNT_ID,
      setItem: () => {},
      removeItem: () => {},
    };

    expect(forgetLastKnownOwner(amnesiac)).toBe(false);
  });

  it("reports failure when the neutralising write itself throws", () => {
    const deleteIgnoredWriteBlocked: LastKnownOwnerStorage = {
      getItem: () => ACCOUNT_ID,
      setItem() {
        throw new DOMException("QuotaExceededError");
      },
      removeItem: () => {},
    };

    expect(forgetLastKnownOwner(deleteIgnoredWriteBlocked)).toBe(false);
  });

  it("reports failure when a write silently stores something else", () => {
    const contrary: LastKnownOwnerStorage = {
      getItem: () => OTHER_ACCOUNT_ID,
      setItem: () => {},
      removeItem: () => {},
    };

    expect(rememberLastKnownOwner(ACCOUNT_ID, contrary)).toBe(false);
  });

  it("reports failure when remembering is refused for an unusable id", () => {
    const storage = fakeStorage();
    expect(rememberLastKnownOwner("", storage)).toBe(false);
  });

  it("reports failure when a forget cannot be confirmed because reads throw", () => {
    // removeItem succeeds, getItem throws: the module cannot establish that
    // the memory is gone, so it must not claim it is.
    const writeOnly: LastKnownOwnerStorage = {
      getItem() {
        throw new DOMException("SecurityError");
      },
      setItem: () => {},
      removeItem: () => {},
    };

    expect(forgetLastKnownOwner(writeOnly)).toBe(false);
  });
});

describe("the ambient default", () => {
  it("uses globalThis.localStorage when no storage is passed", () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);

    rememberLastKnownOwner(ACCOUNT_ID);
    expect(readLastKnownOwner()).toBe(ACCOUNT_ID);
    forgetLastKnownOwner();
    expect(readLastKnownOwner()).toBeNull();
  });

  it("degrades when reading globalThis.localStorage itself throws", () => {
    // A sandboxed iframe with storage disabled throws on the PROPERTY READ,
    // not merely on the method call — so a `typeof window` test would not be
    // enough, and the access itself has to sit inside the try.
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("SecurityError");
      },
    });

    expect(readLastKnownOwner()).toBeNull();
    expect(() => rememberLastKnownOwner(ACCOUNT_ID)).not.toThrow();
    expect(() => forgetLastKnownOwner()).not.toThrow();
  });

  it("degrades when there is no localStorage at all (SSR / prerender)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readLastKnownOwner()).toBeNull();
    expect(() => rememberLastKnownOwner(ACCOUNT_ID)).not.toThrow();
  });
});
