import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import {
  cacheLearnerRelease,
  readVerifiedActiveCachedRelease,
  readVerifiedCachedRelease,
  SAFWA_DB_VERSION,
  SafwaDb,
} from "@/modules/content/db";
import { loadActiveContent, sha256HexBrowser } from "@/modules/content/load";

// Web Crypto for sha256HexBrowser under jsdom.
if (typeof globalThis.crypto?.subtle === "undefined") {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

// Full-artifact verification over 455 entries through fake-indexeddb is
// slow under V8 coverage instrumentation; allow generous per-test time.
vi.setConfig({ testTimeout: 30_000 });

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const LEARNER_TEXT = built.serialized.learner;
const LEARNER_SHA = built.checksums.learner;

let dbCounter = 0;
let db: SafwaDb;

function pointerResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return { ...built.activePointer, ...overrides };
}

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
        : new Response(LEARNER_TEXT, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-content-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
  vi.unstubAllGlobals();
});

describe("Dexie schema v3", () => {
  it("creates the content, learner-state and derived-cache stores at version 3", async () => {
    await db.open();
    expect(db.verno).toBe(SAFWA_DB_VERSION);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "bookmarks",
      "contentEntries",
      "contentMetadata",
      "contentReleases",
      "daily_activity",
      "lists",
      "mutation_queue",
      "profile",
      "review_events",
      "sessions",
      "settings",
      "study_attempts",
      "study_components",
      "sync_state",
    ]);
  });

  it("caches the exact serialized artifact and reads all 455 entries", async () => {
    await cacheLearnerRelease(db, LEARNER_TEXT, LEARNER_SHA, 123);
    const record = await db.contentReleases.get(built.releaseId);
    expect(record!.serializedLearner).toBe(LEARNER_TEXT);
    const cached = await readVerifiedCachedRelease(db, built.releaseId);
    expect(cached).not.toBeNull();
    expect(cached!.entries).toHaveLength(455);
    expect(cached!.entries[0].id).toBe(1);
    const active = await readVerifiedActiveCachedRelease(db);
    expect(active!.release.releaseId).toBe(built.releaseId);
  });

  it("rejects a write whose checksum does not match the bytes", async () => {
    await expect(
      cacheLearnerRelease(db, LEARNER_TEXT, "0".repeat(64)),
    ).rejects.toThrow(/checksum mismatch/);
    expect(await db.contentReleases.count()).toBe(0);
  });

  it("a fabricated checksum cannot make arbitrary content valid", async () => {
    const arbitrary = '{"anything": true}';
    const itsRealHash = await sha256HexBrowser(arbitrary);
    // Even with the CORRECT hash of arbitrary bytes, schema validation fails.
    await expect(
      cacheLearnerRelease(db, arbitrary, itsRealHash),
    ).rejects.toThrow();
    expect(await db.contentReleases.count()).toBe(0);
  });

  it("rejects entry_count/entries disagreement and duplicate ids", async () => {
    const parsed = JSON.parse(LEARNER_TEXT) as {
      entry_count: number;
      entries: Array<{ id: number }>;
    };
    parsed.entries[1].id = parsed.entries[0].id; // duplicate id
    const tamperedDup = JSON.stringify(parsed);
    await expect(
      cacheLearnerRelease(db, tamperedDup, await sha256HexBrowser(tamperedDup)),
    ).rejects.toThrow(/duplicate entry ids/);
  });

  it("a failed transaction cannot become the active release", async () => {
    // Force a mid-transaction failure: the release row is written before
    // the entry rows, so aborting bulkPut must roll everything back.
    const spy = vi
      .spyOn(db.contentEntries, "bulkPut")
      .mockImplementation(() => {
        throw new Error("simulated failure mid-transaction");
      });
    await expect(
      cacheLearnerRelease(db, LEARNER_TEXT, LEARNER_SHA),
    ).rejects.toThrow(/simulated failure/);
    spy.mockRestore();
    expect(await readVerifiedActiveCachedRelease(db)).toBeNull();
    expect(await db.contentReleases.count()).toBe(0);
    expect(await db.contentMetadata.count()).toBe(0);
  });

  it("two releases may coexist; activation switches without deleting", async () => {
    await cacheLearnerRelease(db, LEARNER_TEXT, LEARNER_SHA);
    const second = LEARNER_TEXT.replace(
      built.releaseId,
      "safwa-2.2.0-fixture00000000",
    );
    await cacheLearnerRelease(db, second, await sha256HexBrowser(second));
    expect(await db.contentReleases.count()).toBe(2);
    const active = await readVerifiedActiveCachedRelease(db);
    expect(active!.release.releaseId).toBe("safwa-2.2.0-fixture00000000");
    expect(await readVerifiedCachedRelease(db, built.releaseId)).not.toBeNull();
  });
});

describe("verified cache reads (tampering)", () => {
  beforeEach(async () => {
    await cacheLearnerRelease(db, LEARNER_TEXT, LEARNER_SHA);
  });

  it("a tampered serialized artifact is rejected", async () => {
    await db.contentReleases.update(built.releaseId, {
      serializedLearner: LEARNER_TEXT.replace(
        '"meaning": "to spend"',
        '"meaning": "tampered"',
      ),
    });
    expect(await readVerifiedCachedRelease(db, built.releaseId)).toBeNull();
    expect(await readVerifiedActiveCachedRelease(db)).toBeNull();
  });

  it("a tampered stored checksum is rejected", async () => {
    await db.contentReleases.update(built.releaseId, {
      learnerChecksum: "f".repeat(64),
    });
    expect(await readVerifiedCachedRelease(db, built.releaseId)).toBeNull();
  });

  it("tampered cached metadata is rejected", async () => {
    await db.contentReleases.update(built.releaseId, { entryCount: 454 });
    expect(await readVerifiedCachedRelease(db, built.releaseId)).toBeNull();
    await db.contentReleases.update(built.releaseId, {
      entryCount: 455,
      contentVersion: "9.9.9",
    });
    expect(await readVerifiedCachedRelease(db, built.releaseId)).toBeNull();
  });

  it("altered indexed rows are never returned; they are rebuilt from the artifact", async () => {
    const row = await db.contentEntries.get([built.releaseId, 1]);
    await db.contentEntries.put({
      ...row!,
      entry: { ...row!.entry, meaning: "tampered row" },
    });
    const cached = await readVerifiedCachedRelease(db, built.releaseId);
    expect(cached).not.toBeNull();
    // Returned entries come from the verified artifact, not the row.
    expect(cached!.entries[0].meaning).not.toBe("tampered row");
    // And the row was repaired transactionally.
    const repaired = await db.contentEntries.get([built.releaseId, 1]);
    expect(repaired!.entry.meaning).toBe(cached!.entries[0].meaning);
  });

  it.each([
    ["bab", { bab: "hasiba" }],
    ["verbType", { verbType: "lafif_maqrun" }],
    ["bookPage", { bookPage: 999 }],
  ] as const)(
    "a tampered denormalised %s index is detected and repaired",
    async (_field, patch) => {
      // Entry 1 is sahih/nasara/page 1 — tamper one indexed field only.
      const row = await db.contentEntries.get([built.releaseId, 1]);
      await db.contentEntries.put({ ...row!, ...patch });

      const cached = await readVerifiedCachedRelease(db, built.releaseId);
      expect(cached).not.toBeNull();
      // Returned values come from the verified artifact.
      expect(cached!.entries[0].bab).toBe("nasara");
      expect(cached!.entries[0].verb_type).toBe("sahih");
      expect(cached!.entries[0].book_page).toBe(1);

      // The row itself was repaired…
      const repaired = await db.contentEntries.get([built.releaseId, 1]);
      expect(repaired!.bab).toBe("nasara");
      expect(repaired!.verbType).toBe("sahih");
      expect(repaired!.bookPage).toBe(1);

      // …and a subsequent indexed query uses the repaired values: no row
      // carries the corrupted index value anymore.
      const byTamperedBab = await db.contentEntries
        .where("bab")
        .equals("hasiba")
        .and((candidate) => candidate.entryId === 1)
        .count();
      expect(byTamperedBab).toBe(0);
      const byRealBab = await db.contentEntries
        .where("bab")
        .equals("nasara")
        .and((candidate) => candidate.entryId === 1)
        .count();
      expect(byRealBab).toBe(1);
    },
  );

  it("an unexpected extra row is detected and removed", async () => {
    await db.contentEntries.put({
      releaseId: built.releaseId,
      entryId: 9999,
      bab: "nasara",
      verbType: "sahih",
      bookPage: 1,
      entry: { ...built.learner.entries[0], id: 9999 },
    });
    const cached = await readVerifiedCachedRelease(db, built.releaseId);
    expect(cached).not.toBeNull();
    expect(cached!.entries).toHaveLength(455);
    expect(
      await db.contentEntries.get([built.releaseId, 9999]),
    ).toBeUndefined();
    expect(
      await db.contentEntries
        .where("releaseId")
        .equals(built.releaseId)
        .count(),
    ).toBe(455);
  });

  it("missing indexed rows are rebuilt from the verified artifact", async () => {
    await db.contentEntries
      .where("releaseId")
      .equals(built.releaseId)
      .limit(10)
      .delete();
    const cached = await readVerifiedCachedRelease(db, built.releaseId);
    expect(cached).not.toBeNull();
    expect(cached!.entries).toHaveLength(455);
    expect(
      await db.contentEntries
        .where("releaseId")
        .equals(built.releaseId)
        .count(),
    ).toBe(455);
  });

  it("matching pointer checksum alone is insufficient — bytes must verify", async () => {
    // Stored checksum metadata matches the pointer, but the bytes differ.
    await db.contentReleases.update(built.releaseId, {
      serializedLearner: LEARNER_TEXT.replace(
        '"meaning": "to spend"',
        '"meaning": "evil"',
      ),
      learnerChecksum: LEARNER_SHA, // claims to match
    });
    expect(
      await readVerifiedCachedRelease(db, built.releaseId, LEARNER_SHA),
    ).toBeNull();
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
  });

  it("uses the verified cache without re-downloading", async () => {
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

  it("corrupt matching cache + working network causes a clean redownload", async () => {
    mockFetch({});
    await loadActiveContent(db);
    await db.contentReleases.update(built.releaseId, {
      serializedLearner: LEARNER_TEXT.replace(
        '"meaning": "to spend"',
        '"meaning": "corrupt"',
      ),
    });
    const fetchMock = mockFetch({});
    const result = await loadActiveContent(db);
    expect(result.ok && result.source).toBe("network");
    expect(fetchMock).toHaveBeenCalledTimes(2); // pointer + learner redownload
    // Cache repaired by the redownload.
    const cached = await readVerifiedCachedRelease(db, built.releaseId);
    expect(cached!.entries[0].meaning).toBe("to spend");
  });

  it("corrupt cache + no network returns no-content-available", async () => {
    mockFetch({});
    await loadActiveContent(db);
    await db.contentReleases.update(built.releaseId, {
      learnerChecksum: "f".repeat(64),
    });
    mockFetch({
      pointer: () => {
        throw new TypeError("offline");
      },
    });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no-content-available");
  });

  it("network failure falls back with source fallback-cache and reason pointer-unavailable", async () => {
    mockFetch({});
    await loadActiveContent(db);
    mockFetch({
      pointer: () => {
        throw new TypeError("network down");
      },
    });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("fallback-cache");
    expect(result.fallbackReason).toBe("pointer-unavailable");
    expect(result.entryCount).toBe(455);
  });

  it("download failure falls back with reason download-failed", async () => {
    mockFetch({});
    await loadActiveContent(db);
    mockFetch({
      pointer: () =>
        Response.json(
          pointerResponse({
            release_id: "safwa-2.2.0-newrelease000000",
            learner_url:
              "/content/releases/safwa-2.2.0-newrelease000000/learner.json",
          }),
        ),
      learner: () => new Response("gone", { status: 404 }),
    });
    const result = await loadActiveContent(db);
    expect(result.ok && result.source).toBe("fallback-cache");
    if (result.ok) {
      expect(result.fallbackReason).toBe("download-failed");
      expect(result.releaseId).toBe(built.releaseId);
    }
  });

  it("checksum mismatch falls back with reason checksum-mismatch, not offline", async () => {
    mockFetch({});
    await loadActiveContent(db);
    const corrupt = LEARNER_TEXT.replace(
      '"meaning": "to spend"',
      '"meaning": "tampered"',
    );
    mockFetch({
      pointer: () =>
        Response.json(
          pointerResponse({ release_id: "safwa-2.2.0-tampered00000000" }),
        ),
      learner: () => new Response(corrupt, { status: 200 }),
    });
    const result = await loadActiveContent(db);
    expect(result.ok && result.source).toBe("fallback-cache");
    if (result.ok) expect(result.fallbackReason).toBe("checksum-mismatch");
  });

  it("checksum mismatch with no cache is a typed failure; nothing activates", async () => {
    const corrupt = LEARNER_TEXT.replace(
      '"entry_count": 455',
      '"entry_count": 454',
    );
    mockFetch({ learner: () => new Response(corrupt, { status: 200 }) });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("checksum-mismatch");
    expect(await readVerifiedActiveCachedRelease(db)).toBeNull();
  });

  it("pointer/release metadata mismatch never activates the download", async () => {
    // Serve the real artifact under a pointer that claims a different id
    // WITH the correct checksum of those bytes — agreement check must fire.
    mockFetch({
      pointer: () =>
        Response.json(
          pointerResponse({
            release_id: "safwa-2.2.0-differentid00000",
            learner_url:
              "/content/releases/safwa-2.2.0-differentid00000/learner.json",
          }),
        ),
    });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pointer-invalid");
    expect(await readVerifiedActiveCachedRelease(db)).toBeNull();
  });

  it("invalid (Zod-failing) payload with a correct hash is rejected", async () => {
    const parsed = JSON.parse(LEARNER_TEXT) as Record<string, unknown>;
    parsed.internal_note = "leaked field";
    const invalid = JSON.stringify(parsed);
    const invalidHash = await sha256HexBrowser(invalid);
    mockFetch({
      pointer: () =>
        Response.json(pointerResponse({ learner_sha256: invalidHash })),
      learner: () => new Response(invalid, { status: 200 }),
    });
    const result = await loadActiveContent(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-release");
  });

  it("browser sha256 agrees with the build checksum", async () => {
    expect(await sha256HexBrowser(LEARNER_TEXT)).toBe(LEARNER_SHA);
  });
});
