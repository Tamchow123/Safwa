import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import {
  cacheLearnerRelease,
  CONTENT_DB_VERSION,
  readActiveCachedRelease,
  readCachedRelease,
  SafwaContentDb,
} from "@/modules/content/db";
import { loadActiveContent, sha256HexBrowser } from "@/modules/content/load";

// Web Crypto for sha256HexBrowser under jsdom.
if (typeof globalThis.crypto?.subtle === "undefined") {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));

let dbCounter = 0;
let db: SafwaContentDb;

function pointerResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...built.activePointer,
    ...overrides,
  };
}

/** fetch mock serving pointer + learner text (overridable per test). */
function mockFetch(options: {
  pointer?: () => Response | Promise<Response>;
  learner?: () => Response | Promise<Response>;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/content/active.json")) {
      return options.pointer
        ? options.pointer()
        : Response.json(pointerResponse());
    }
    if (url.includes("/content/releases/")) {
      return options.learner
        ? options.learner()
        : new Response(built.serialized.learner, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaContentDb(`safwa-content-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
  vi.unstubAllGlobals();
});

describe("Dexie content schema v1", () => {
  it("creates the expected stores at version 1", async () => {
    await db.open();
    expect(db.verno).toBe(CONTENT_DB_VERSION);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "contentEntries",
      "contentMetadata",
      "contentReleases",
    ]);
  });

  it("caches a release transactionally and reads all 455 entries", async () => {
    await cacheLearnerRelease(db, built.learner, built.checksums.learner, 123);
    const cached = await readCachedRelease(db, built.releaseId);
    expect(cached).not.toBeNull();
    expect(cached!.entries).toHaveLength(455);
    expect(cached!.entries[0].id).toBe(1);
    expect(cached!.release.learnerChecksum).toBe(built.checksums.learner);
    const active = await readActiveCachedRelease(db);
    expect(active!.release.releaseId).toBe(built.releaseId);
  });

  it("a failed write cannot become the active release", async () => {
    const broken = {
      ...built.learner,
      // entry_count disagrees with entries -> bulkPut succeeds but the
      // release row claims more entries than exist; simulate a mid-write
      // failure instead by aborting the transaction.
    };
    await expect(
      db.transaction(
        "rw",
        [db.contentReleases, db.contentEntries, db.contentMetadata],
        async () => {
          await cacheLearnerRelease(db, broken, built.checksums.learner);
          throw new Error("simulated failure after write");
        },
      ),
    ).rejects.toThrow("simulated failure");
    expect(await readActiveCachedRelease(db)).toBeNull();
    expect(await db.contentReleases.count()).toBe(0);
  });

  it("two releases may coexist; activation switches without deleting", async () => {
    await cacheLearnerRelease(db, built.learner, built.checksums.learner);
    const second = {
      ...built.learner,
      release_id: "safwa-2.2.0-fixture000000",
    };
    await cacheLearnerRelease(db, second, "0".repeat(64));
    expect(await db.contentReleases.count()).toBe(2);
    const active = await readActiveCachedRelease(db);
    expect(active!.release.releaseId).toBe("safwa-2.2.0-fixture000000");
    expect(await readCachedRelease(db, built.releaseId)).not.toBeNull();
  });

  it("an incomplete entry set invalidates the cached release", async () => {
    await cacheLearnerRelease(db, built.learner, built.checksums.learner);
    await db.contentEntries
      .where("releaseId")
      .equals(built.releaseId)
      .limit(10)
      .delete();
    expect(await readCachedRelease(db, built.releaseId)).toBeNull();
  });
});

describe("content loader", () => {
  it("downloads, verifies and caches on first load", async () => {
    const fetchMock = mockFetch({});
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("network");
    expect(result.entryCount).toBe(455);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readActiveCachedRelease(db)).not.toBeNull();
  });

  it("uses the cache without re-downloading the learner artifact", async () => {
    mockFetch({});
    await loadActiveContent(db);
    const fetchMock = mockFetch({
      learner: () => {
        throw new Error("learner must not be downloaded again");
      },
    });
    const result = await loadActiveContent(db);
    expect(result.ok && result.source).toBe("cache");
    expect(fetchMock).toHaveBeenCalledTimes(1); // pointer only
  });

  it("falls back to the cached active release when the pointer is unreachable", async () => {
    mockFetch({});
    await loadActiveContent(db);
    mockFetch({
      pointer: () => {
        throw new TypeError("network down");
      },
    });
    const result = await loadActiveContent(db);
    expect(result.ok && result.source).toBe("offline-fallback");
    if (result.ok) expect(result.entryCount).toBe(455);
  });

  it("preserves the old cache when the learner download fails", async () => {
    mockFetch({});
    await loadActiveContent(db);
    mockFetch({
      pointer: () =>
        Response.json(
          pointerResponse({
            release_id: "safwa-2.2.0-newrelease00",
            learner_url:
              "/content/releases/safwa-2.2.0-newrelease00/learner.json",
          }),
        ),
      learner: () => new Response("gone", { status: 404 }),
    });
    const result = await loadActiveContent(db);
    expect(result.ok && result.source).toBe("offline-fallback");
    if (result.ok) expect(result.releaseId).toBe(built.releaseId);
  });

  it("rejects a checksum mismatch and never activates the corrupt release", async () => {
    const corrupt = built.serialized.learner.replace(
      '"entry_count": 455',
      '"entry_count": 454',
    );
    mockFetch({ learner: () => new Response(corrupt, { status: 200 }) });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("checksum-mismatch");
    expect(await readActiveCachedRelease(db)).toBeNull();
  });

  it("checksum mismatch falls back to an existing valid cache", async () => {
    mockFetch({});
    await loadActiveContent(db);
    const corruptText = built.serialized.learner.replace(
      '"meaning": "to spend"',
      '"meaning": "tampered"',
    );
    mockFetch({
      pointer: () =>
        Response.json(
          pointerResponse({ release_id: "safwa-2.2.0-tampered0000" }),
        ),
      learner: () => new Response(corruptText, { status: 200 }),
    });
    const result = await loadActiveContent(db);
    expect(result.ok && result.source).toBe("offline-fallback");
    if (result.ok) expect(result.releaseId).toBe(built.releaseId);
  });

  it("rejects invalid JSON and Zod-invalid payloads", async () => {
    const notJson = "not json at all";
    mockFetch({
      pointer: () =>
        Response.json(
          pointerResponse({
            learner_sha256: undefined,
          }),
        ),
    });
    // Pointer missing checksum fails Zod at the pointer stage.
    const pointerResult = await loadActiveContent(db);
    expect(pointerResult.ok).toBe(false);

    const badChecksum = await sha256HexBrowser(notJson);
    mockFetch({
      pointer: () =>
        Response.json(pointerResponse({ learner_sha256: badChecksum })),
      learner: () => new Response(notJson, { status: 200 }),
    });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-release");
  });

  it("rejects a pointer/release metadata mismatch", async () => {
    mockFetch({
      pointer: () =>
        Response.json(
          pointerResponse({
            release_id: "safwa-2.2.0-differentid0",
            learner_url:
              "/content/releases/safwa-2.2.0-differentid0/learner.json",
          }),
        ),
    });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pointer-invalid");
    expect(await readActiveCachedRelease(db)).toBeNull();
  });

  it("returns a typed error when nothing is available at all", async () => {
    mockFetch({
      pointer: () => {
        throw new TypeError("offline");
      },
    });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no-content-available");
  });

  it("browser sha256 agrees with the build checksum", async () => {
    expect(await sha256HexBrowser(built.serialized.learner)).toBe(
      built.checksums.learner,
    );
  });
});
