import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CACHE_NAMES,
  OFFLINE_FALLBACK_URL,
  OWNER_SENSITIVE_CACHE_NAMES,
} from "@/modules/pwa/cache-rules";
import {
  clearAllAppCaches,
  clearAllAppCachesIfAvailable,
  clearOwnerSensitiveCaches,
  clearOwnerSensitiveCachesIfAvailable,
  readOfflineFallback,
  warmOfflineFallback,
} from "@/modules/pwa/cache-storage";

/**
 * The Cache Storage side of the service worker, against a fake `CacheStorage`.
 *
 * These three functions are the only places this app writes to or deletes from
 * Cache Storage, and each has a failure mode that is silent in production: an
 * install that fails because one page could not be fetched, a fallback that is
 * missing at the moment it is finally needed, and a sign-out that leaves
 * account markup behind. Each is provoked here.
 *
 * The fake is honest about the two behaviours the code depends on: `add`
 * fetches, so a rejected fetch rejects the `add` exactly as the real one does,
 * and `delete` answers false for a cache that was never opened.
 */

/** The worker's own location — what `sw.ts` passes as the base. */
const WORKER_BASE = "https://safwa.example/serwist/sw.js";
const EXPECTED_URL = `https://safwa.example${OFFLINE_FALLBACK_URL}`;

/**
 * `contents` is returned rather than snapshotted, so an assertion can read
 * which caches exist AFTER the code under test has opened and deleted some.
 *
 * The `as unknown as` casts are deliberate and not hiding a mismatch: the real
 * `Cache` and `CacheStorage` declare a dozen methods between them, and the
 * three functions under test call exactly `open`, `add`, `match` and `delete`.
 * Implementing the rest would add fifty lines that no test could reach.
 */
function createObservableStorage(
  options: {
    addFails?: boolean;
    deleteFails?: string;
    keysFails?: boolean;
  } = {},
) {
  const contents = new Map<string, Map<string, Response>>();
  const added: Request[] = [];

  const storage = {
    open: async (name: string) => {
      let entries = contents.get(name);
      if (!entries) {
        entries = new Map<string, Response>();
        contents.set(name, entries);
      }
      const stored = entries;
      return {
        add: async (request: RequestInfo | URL) => {
          added.push(request as Request);
          if (options.addFails) throw new TypeError("Failed to fetch");
          stored.set(String((request as Request).url), new Response("<html>"));
        },
        match: async (request: RequestInfo | URL) =>
          stored.get(typeof request === "string" ? request : String(request)),
      } as unknown as Cache;
    },
    delete: async (name: string) => {
      if (options.deleteFails === name) throw new Error("blocked");
      return contents.delete(name);
    },
    keys: async () => {
      if (options.keysFails) throw new Error("blocked");
      return [...contents.keys()];
    },
  } as unknown as CacheStorage;

  return { storage, contents, added };
}

/**
 * Several tests here fail the warm on purpose, and the warn it now emits is a
 * feature (REL-009) rather than noise to read past. Spied for the whole file so
 * the suite stays quiet, and asserted in the one test that is about it.
 */
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("warming the offline fallback", () => {
  it("stores the offline page, requested past the HTTP cache", async () => {
    const { storage, contents, added } = createObservableStorage();

    expect(await warmOfflineFallback(storage, WORKER_BASE)).toBe(true);
    expect(contents.has(CACHE_NAMES.offlineFallback)).toBe(true);
    expect(added).toHaveLength(1);
    // Resolved against the WORKER's location, not the page's — `/~offline`
    // relative to `/serwist/sw.js` is still origin-root.
    expect(added[0]!.url).toBe(EXPECTED_URL);
    // Without this the warm can be answered from the HTTP cache with the
    // PREVIOUS build's offline page, which is the one thing it exists to avoid.
    expect(added[0]!.cache).toBe("reload");
  });

  it("reports failure instead of throwing, so a bad network cannot fail the install", async () => {
    // The whole reason this returns a boolean rather than rejecting: it runs
    // inside `install`'s waitUntil, where a rejection discards the entire
    // service worker — offline study included — over one uncacheable page.
    const { storage } = createObservableStorage({ addFails: true });
    await expect(warmOfflineFallback(storage, WORKER_BASE)).resolves.toBe(
      false,
    );
  });

  it("leaves a trace when it fails, since nothing downstream will", async () => {
    // Without this the failure is invisible: `handlerDidError` returns
    // undefined and Serwist rethrows the ORIGINAL network error, so a deploy
    // that broke /~offline for every client would surface as unlabelled
    // browser error pages with nothing to search logs for.
    const { storage } = createObservableStorage({ addFails: true });
    await warmOfflineFallback(storage, WORKER_BASE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("offline fallback");
  });

  it("reports failure when Cache Storage itself is unavailable", async () => {
    const storage = {
      open: async () => {
        throw new Error("storage blocked");
      },
    } as unknown as CacheStorage;
    await expect(warmOfflineFallback(storage, WORKER_BASE)).resolves.toBe(
      false,
    );
  });
});

describe("reading the offline fallback", () => {
  it("finds what warming stored, under the same URL", async () => {
    // The pairing is the whole point: a warm and a read that resolved the URL
    // differently would each look correct and never meet.
    const { storage } = createObservableStorage();
    await warmOfflineFallback(storage, WORKER_BASE);
    await expect(
      readOfflineFallback(storage, WORKER_BASE),
    ).resolves.toBeInstanceOf(Response);
  });

  it("returns undefined when warming never succeeded", async () => {
    // `handlerDidError` treats undefined as "no fallback available" and
    // rethrows the original failure, which is the honest outcome — throwing
    // here would replace a network error with a worker error.
    const { storage } = createObservableStorage({ addFails: true });
    await warmOfflineFallback(storage, WORKER_BASE);
    await expect(
      readOfflineFallback(storage, WORKER_BASE),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when Cache Storage itself is unavailable", async () => {
    const storage = {
      open: async () => {
        throw new Error("storage blocked");
      },
    } as unknown as CacheStorage;
    await expect(
      readOfflineFallback(storage, WORKER_BASE),
    ).resolves.toBeUndefined();
  });
});

describe("clearing account-sensitive caches on sign-out", () => {
  const withEveryCache = async (options?: { deleteFails?: string }) => {
    const fake = createObservableStorage(options);
    for (const name of Object.values(CACHE_NAMES))
      await fake.storage.open(name);
    return fake;
  };

  it("deletes the document and RSC caches", async () => {
    const { storage, contents } = await withEveryCache();
    const deleted = await clearOwnerSensitiveCaches(storage);
    expect(deleted.sort()).toEqual([...OWNER_SENSITIVE_CACHE_NAMES].sort());
    expect(contents.has(CACHE_NAMES.documents)).toBe(false);
    expect(contents.has(CACHE_NAMES.rsc)).toBe(false);
  });

  it("leaves the caches that are identical for every learner", async () => {
    // Sweeping these would cost an offline learner their app shell and their
    // downloaded vocabulary to protect data that is not account-specific.
    const { storage, contents } = await withEveryCache();
    await clearOwnerSensitiveCaches(storage);
    expect(contents.has(CACHE_NAMES.buildAssets)).toBe(true);
    expect(contents.has(CACHE_NAMES.contentReleases)).toBe(true);
    expect(contents.has(CACHE_NAMES.appShell)).toBe(true);
    expect(contents.has(CACHE_NAMES.offlineFallback)).toBe(true);
  });

  it("reports nothing deleted when the caches were never created", async () => {
    // "Nothing to delete" and "failed to delete" must not look the same to a
    // caller, which is why this returns the names rather than void.
    const { storage } = createObservableStorage();
    await expect(clearOwnerSensitiveCaches(storage)).resolves.toEqual([]);
  });

  it("keeps going when one cache refuses to delete", async () => {
    const { storage, contents } = await withEveryCache({
      deleteFails: CACHE_NAMES.documents,
    });
    const deleted = await clearOwnerSensitiveCaches(storage);
    expect(deleted).toEqual([CACHE_NAMES.rsc]);
    expect(contents.has(CACHE_NAMES.rsc)).toBe(false);
  });
});

/**
 * The one-line wrapper the departure paths call.
 *
 * It exists because there are two of them and the first version of this slice
 * gave the sweep to only one, so every caller now gets the same three
 * behaviours rather than repeating them: tolerate a missing `caches`, never
 * propagate, return nothing worth branching on.
 */
describe("the wrapper both departure paths call", () => {
  const globals = globalThis as { caches?: CacheStorage };
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "caches", original);
    else delete globals.caches;
  });

  it("sweeps the global Cache Storage when there is one", async () => {
    const { storage, contents } = createObservableStorage();
    for (const name of Object.values(CACHE_NAMES)) await storage.open(name);
    Object.defineProperty(globalThis, "caches", {
      value: storage,
      configurable: true,
    });

    await clearOwnerSensitiveCachesIfAvailable();
    expect(contents.has(CACHE_NAMES.documents)).toBe(false);
    expect(contents.has(CACHE_NAMES.rsc)).toBe(false);
    expect(contents.has(CACHE_NAMES.buildAssets)).toBe(true);
  });

  it("does nothing where Cache Storage does not exist", async () => {
    // Server rendering, and any browser without it. A departure path must not
    // throw here — sign-out has already ended the session by this point.
    delete globals.caches;
    await expect(
      clearOwnerSensitiveCachesIfAvailable(),
    ).resolves.toBeUndefined();
  });

  it("never propagates a failure to the caller", async () => {
    Object.defineProperty(globalThis, "caches", {
      value: {
        delete: async () => {
          throw new Error("storage blocked");
        },
      } as unknown as CacheStorage,
      configurable: true,
    });
    await expect(
      clearOwnerSensitiveCachesIfAvailable(),
    ).resolves.toBeUndefined();
  });
});

/**
 * The kill switch's second half (slice 11).
 *
 * Unregistering the worker stops it intercepting; it does **not** empty Cache
 * Storage, because the caches belong to the origin rather than to the
 * registration and nothing about removing a registration touches them. Serwist's
 * precache is pruned by a NEW worker's activate-time cleanup, which a rollback
 * never runs because it installs no replacement — so this function is the only
 * thing that removes anything.
 */
describe("clearing every cache, for the kill switch", () => {
  const globals = globalThis as { caches?: CacheStorage };
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "caches", original);
    else delete globals.caches;
  });

  const withEveryCache = async () => {
    const fake = createObservableStorage();
    for (const name of Object.values(CACHE_NAMES))
      await fake.storage.open(name);
    return fake;
  };

  it("deletes all seven, not just the account-sensitive two", async () => {
    const { storage, contents } = await withEveryCache();
    const deleted = await clearAllAppCaches(storage);
    expect(deleted.sort()).toEqual(Object.values(CACHE_NAMES).sort());
    expect(contents.size).toBe(0);
    // And the sign-out sweep is still the narrow one — an ordinary sign-out
    // must not make the next learner on a shared device re-download the app.
    expect(OWNER_SENSITIVE_CACHE_NAMES.length).toBeLessThan(
      Object.values(CACHE_NAMES).length,
    );
  });

  it("removes a cache this module has never heard of", async () => {
    // Serwist's precache is the concrete case, and it is the reason the sweep
    // enumerates: unregistering does NOT remove it, and no replacement worker
    // will ever activate to clean it up, so a named-caches-only sweep would
    // leave it on the device permanently. The same reasoning covers a cache
    // written by a build that is being rolled back precisely because nobody
    // knows quite what it did.
    const { storage, contents } = await withEveryCache();
    await storage.open("serwist-precache-v2-https://safwa.example/");
    await clearAllAppCaches(storage);
    expect(contents.size).toBe(0);
  });

  it("falls back to the names it knows when it cannot enumerate", async () => {
    // Partial is better than nothing, and the difference shows in the return
    // value rather than being swallowed.
    const fake = createObservableStorage({ keysFails: true });
    for (const name of Object.values(CACHE_NAMES))
      await fake.storage.open(name);
    await fake.storage.open("unknown-to-this-module");
    const deleted = await clearAllAppCaches(fake.storage);
    expect(deleted.sort()).toEqual(Object.values(CACHE_NAMES).sort());
    expect([...fake.contents.keys()]).toEqual(["unknown-to-this-module"]);
  });

  it("keeps going when one cache refuses", async () => {
    const fake = createObservableStorage({
      deleteFails: CACHE_NAMES.documents,
    });
    for (const name of Object.values(CACHE_NAMES))
      await fake.storage.open(name);
    const deleted = await clearAllAppCaches(fake.storage);
    expect(deleted).not.toContain(CACHE_NAMES.documents);
    expect(deleted).toHaveLength(Object.values(CACHE_NAMES).length - 1);
  });

  it("degrades to nothing where Cache Storage does not exist", async () => {
    delete globals.caches;
    await expect(clearAllAppCachesIfAvailable()).resolves.toEqual([]);
  });

  it("never propagates a failure through the wrapper", async () => {
    Object.defineProperty(globalThis, "caches", {
      value: {
        delete: async () => {
          throw new Error("storage blocked");
        },
      } as unknown as CacheStorage,
      configurable: true,
    });
    // The inner loop already swallows per-cache failures, so this asserts the
    // outer guard: a `caches` whose own property access or shape is broken must
    // still not throw into the effect that calls it.
    await expect(clearAllAppCachesIfAvailable()).resolves.toEqual([]);
  });
});
