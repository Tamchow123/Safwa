import { describe, expect, it } from "vitest";

import { SYNC_BOUNDS, SYNC_PROTOCOL_VERSION } from "./constants";
import {
  emptyGuestMergeSummary,
  GUEST_MERGE_BOUNDS,
  GUEST_MERGE_REASON_CODES,
  guestMergeRequestSchema,
  guestMergeResponseSchema,
  summaryChangedAnything,
  totalChunkItemCount,
  totalDeclaredItems,
  type GuestMergeSummary,
} from "./guest-merge";

// Contains hex LETTERS, so the casing test below is not a no-op.
const IMPORT_KEY = "a1b2c3d4-1111-4111-8111-abcdef012345";
const SNAPSHOT_HASH = "a".repeat(64);

function begin(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "begin",
    importKey: IMPORT_KEY,
    snapshotHash: SNAPSHOT_HASH,
    deviceId: "device-1",
    declared: {
      attempts: 3,
      events: 3,
      bookmarks: 1,
      lists: 0,
      settings: 2,
    },
    ...overrides,
  };
}

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "chunk",
    importKey: IMPORT_KEY,
    snapshotHash: SNAPSHOT_HASH,
    chunkIndex: 0,
    ...overrides,
  };
}

/** A distinct, schema-valid scheduling event — enough of them to fill a chunk. */
function makeEvent(index: number) {
  const hex = index.toString(16).padStart(12, "0");
  return {
    eventId: `11111111-1111-4111-8111-${hex}`,
    studyComponentId: "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english", // prettier-ignore
    attemptId: `22222222-2222-4222-8222-${hex}`,
    rating: "good",
    status: "scheduling",
    baseServerRevision: 0,
    parentEventId: null,
    clientComponentRevision: 1,
    clientSequence: index + 1,
    occurredAtClient: "2026-07-20T10:00:00.000Z",
    deviceId: "device-1",
    sessionId: "33333333-3333-4333-8333-333333333333",
    releaseId: "rel-1",
    contentVersion: "v1",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
  };
}

describe("guestMergeRequestSchema — staging", () => {
  it("accepts each of the three stages", () => {
    expect(guestMergeRequestSchema.safeParse(begin()).success).toBe(true);
    expect(guestMergeRequestSchema.safeParse(chunk()).success).toBe(true);
    expect(
      guestMergeRequestSchema.safeParse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        stage: "finalize",
        importKey: IMPORT_KEY,
        snapshotHash: SNAPSHOT_HASH,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown stage rather than falling through to a default", () => {
    const parsed = guestMergeRequestSchema.safeParse(begin({ stage: "apply" }));
    expect(parsed.success).toBe(false);
  });

  it("rejects a protocol version it does not implement", () => {
    expect(
      guestMergeRequestSchema.safeParse(begin({ protocolVersion: 99 })).success,
    ).toBe(false);
  });

  it("rejects an unknown top-level field instead of ignoring it", () => {
    // strictObject: a client cannot smuggle an extra field past the schema in
    // the hope a handler reads it (§30 — no client-accessible merge-mode bypass).
    expect(
      guestMergeRequestSchema.safeParse(begin({ ingestionMode: "guestMerge" }))
        .success,
    ).toBe(false);
  });

  it("carries no field for a revocation — a guest cannot revoke", () => {
    expect(
      guestMergeRequestSchema.safeParse(chunk({ revocations: [] })).success,
    ).toBe(false);
  });
});

describe("guestMergeRequestSchema — identity", () => {
  it("requires a well-formed import key and snapshot hash on every stage", () => {
    expect(
      guestMergeRequestSchema.safeParse(begin({ importKey: "not-a-uuid" }))
        .success,
    ).toBe(false);
    expect(
      guestMergeRequestSchema.safeParse(begin({ snapshotHash: "short" }))
        .success,
    ).toBe(false);
    // Uppercase hex is a DIFFERENT string; the hash is compared byte-for-byte,
    // so accepting both cases would make two spellings of one hash.
    expect(
      guestMergeRequestSchema.safeParse(begin({ snapshotHash: "A".repeat(64) }))
        .success,
    ).toBe(false);
  });

  it("rejects a RE-CASED import key — the idempotency anchor has one spelling", () => {
    // The key is compared as text by a unique index and an equality lookup, so
    // two spellings would be two keys: a client holding a completed key could
    // re-case it and drive the whole merge again against the same guest history,
    // bypassing the no-op path §12 requires. crypto.randomUUID mints lowercase.
    expect(
      guestMergeRequestSchema.safeParse(
        begin({ importKey: IMPORT_KEY.toUpperCase() }),
      ).success,
    ).toBe(false);
    expect(
      guestMergeRequestSchema.safeParse(
        chunk({ importKey: IMPORT_KEY.toUpperCase() }),
      ).success,
    ).toBe(false);
  });

  it("requires the snapshot hash on a CHUNK, not just on begin", () => {
    // A chunk belonging to a different snapshot than the one the key was opened
    // with must be refused on arrival, not discovered after it has been stored.
    const withoutHash: Record<string, unknown> = chunk();
    delete withoutHash.snapshotHash;
    expect(guestMergeRequestSchema.safeParse(withoutHash).success).toBe(false);
  });
});

describe("guestMergeRequestSchema — bounds", () => {
  it("refuses a declared import larger than one import may carry", () => {
    const parsed = guestMergeRequestSchema.safeParse(
      begin({
        declared: {
          attempts: GUEST_MERGE_BOUNDS.maxDeclaredItems,
          events: 1,
          bookmarks: 0,
          lists: 0,
          settings: 0,
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("refuses a chunk index beyond the maximum chunk count", () => {
    expect(
      guestMergeRequestSchema.safeParse(
        chunk({ chunkIndex: GUEST_MERGE_BOUNDS.maxChunks }),
      ).success,
    ).toBe(false);
    expect(
      guestMergeRequestSchema.safeParse(chunk({ chunkIndex: -1 })).success,
    ).toBe(false);
  });

  it("enforces the per-chunk total at PARSE time, not in a handler", () => {
    // The per-kind caps sum well above the total budget (500+500+500+100+50 =
    // 1650 > 1000), so a chunk can satisfy every individual cap and still be
    // oversized. The total must therefore be refined by the schema itself — a
    // handler that forgot to re-check it would accept the request.
    const events = Array.from({ length: SYNC_BOUNDS.maxEvents }, (_, index) =>
      makeEvent(index),
    );
    const bookmarks = Array.from(
      { length: SYNC_BOUNDS.maxBookmarks },
      (_, index) => ({ entryId: index + 1, createdAt: 1, deleted: false }),
    );
    const settings = Array.from(
      { length: SYNC_BOUNDS.maxSettings },
      (_, index) => ({ key: `k${index}`, value: index, updatedAt: 1 }),
    );

    const body = chunk({ events, bookmarks, settings });
    // Every array is within its own cap...
    expect(events.length).toBe(SYNC_BOUNDS.maxEvents);
    expect(bookmarks.length).toBe(SYNC_BOUNDS.maxBookmarks);
    expect(settings.length).toBe(SYNC_BOUNDS.maxSettings);
    // ...and the total is over budget, so the schema refuses it.
    expect(
      totalChunkItemCount({ attempts: [], lists: [], ...body } as never),
    ).toBeGreaterThan(GUEST_MERGE_BOUNDS.maxItemsPerChunk);
    expect(guestMergeRequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a chunk exactly at the total budget", () => {
    const events = Array.from(
      {
        length: GUEST_MERGE_BOUNDS.maxItemsPerChunk - SYNC_BOUNDS.maxBookmarks,
      },
      (_, index) => makeEvent(index),
    );
    const bookmarks = Array.from(
      { length: SYNC_BOUNDS.maxBookmarks },
      (_, index) => ({ entryId: index + 1, createdAt: 1, deleted: false }),
    );
    const parsed = guestMergeRequestSchema.safeParse(
      chunk({ events, bookmarks }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.stage === "chunk") {
      expect(totalChunkItemCount(parsed.data)).toBe(
        GUEST_MERGE_BOUNDS.maxItemsPerChunk,
      );
    }
  });

  it("bounds a whole import above the client's own snapshot ceiling", () => {
    // A legitimate history must never be refused HERE — the client already
    // refuses an oversized one, loudly, before anything is sent.
    expect(GUEST_MERGE_BOUNDS.maxDeclaredItems).toBeGreaterThan(60_000);
    expect(GUEST_MERGE_BOUNDS.maxItemsPerChunk).toBe(
      SYNC_BOUNDS.maxItemsPerBatch,
    );
  });

  it("defaults every item array so an empty chunk is still well-formed", () => {
    const parsed = guestMergeRequestSchema.safeParse(chunk());
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.stage === "chunk") {
      expect(totalChunkItemCount(parsed.data)).toBe(0);
    }
  });
});

describe("guestMergeResponseSchema", () => {
  it("accepts a begin response that resumes a partially uploaded import", () => {
    const parsed = guestMergeResponseSchema.safeParse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "begin",
      importStatus: "open",
      reasonCode: "accepted",
      resumeFromChunk: 4,
      acceptedItems: 4_000,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a begin response that replays a completed import's summary", () => {
    const parsed = guestMergeResponseSchema.safeParse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "begin",
      importStatus: "completed",
      reasonCode: "already_completed",
      resumeFromChunk: 0,
      acceptedItems: 12,
      summary: emptyGuestMergeSummary(),
    });
    expect(parsed.success).toBe(true);
  });

  it("carries incomplete as a first-class final result", () => {
    const parsed = guestMergeResponseSchema.safeParse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "finalize",
      result: "incomplete",
      reasonCode: "incomplete_upload",
      summary: emptyGuestMergeSummary(),
      serverCursor: 17,
      activeReleaseId: "safwa-2.2.0",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a reason code outside the enumerated vocabulary", () => {
    // No raw error string may ride out on this field (§30).
    const parsed = guestMergeResponseSchema.safeParse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "finalize",
      result: "rejected",
      reasonCode: 'ERROR: duplicate key value violates unique constraint "…"',
      summary: emptyGuestMergeSummary(),
      serverCursor: 0,
      activeReleaseId: "safwa-2.2.0",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a summary on finalisation, even for a no-op", () => {
    const parsed = guestMergeResponseSchema.safeParse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "finalize",
      result: "no_op",
      reasonCode: "already_completed",
      serverCursor: 3,
      activeReleaseId: "safwa-2.2.0",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("guestMergeResponseSchema — list re-keying (§17)", () => {
  function finalize(overrides: Record<string, unknown> = {}) {
    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "finalize",
      result: "applied",
      reasonCode: "accepted",
      summary: emptyGuestMergeSummary(),
      serverCursor: 9,
      activeReleaseId: "safwa-2.2.0",
      ...overrides,
    };
  }

  it("carries a guest-list-id to account-list-id mapping", () => {
    // A guest list folded into an account list of the same normalised name
    // leaves the client holding an id that names nothing; without the mapping it
    // cannot re-key and would duplicate or lose the list.
    const parsed = guestMergeResponseSchema.safeParse(
      finalize({
        listIdMappings: [
          {
            guestListId: "44444444-4444-4444-8444-444444444444",
            accountListId: "55555555-5555-4555-8555-555555555555",
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("defaults the mapping to empty, so a merge with no lists is well-formed", () => {
    const parsed = guestMergeResponseSchema.safeParse(finalize());
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.stage === "finalize") {
      expect(parsed.data.listIdMappings).toEqual([]);
    }
  });

  it("bounds the mapping as a BACKSTOP the coordinator must not rely on", () => {
    // The cumulative 500-list ceiling is not, and cannot be, enforced by this
    // stateless schema: each chunk is parsed alone, so only the per-chunk cap
    // applies to list items and a client ignoring its own declaration can send
    // more across chunks. The .max() here exists so a coordinator that failed to
    // track the running count fails LOUDLY when it serialises the mappings,
    // rather than truncating them and orphaning guest list ids on the client.
    expect(SYNC_BOUNDS.maxLists * GUEST_MERGE_BOUNDS.maxChunks).toBeGreaterThan(
      GUEST_MERGE_BOUNDS.maxLists,
    );
    // The coordinator has a reason code to refuse the excess with.
    expect(GUEST_MERGE_REASON_CODES).toContain("list_ceiling_exceeded");
  });

  it("bounds the mapping, and the declared list count that produces it", () => {
    expect(
      guestMergeResponseSchema.safeParse(
        finalize({
          listIdMappings: Array.from(
            { length: GUEST_MERGE_BOUNDS.maxLists + 1 },
            () => ({
              guestListId: "44444444-4444-4444-8444-444444444444",
              accountListId: "55555555-5555-4555-8555-555555555555",
            }),
          ),
        }),
      ).success,
    ).toBe(false);
    // The declared count is bounded by the same ceiling, so an import can never
    // legitimately produce more mappings than the response can carry.
    expect(
      guestMergeRequestSchema.safeParse(
        begin({
          declared: {
            attempts: 0,
            events: 0,
            bookmarks: 0,
            lists: GUEST_MERGE_BOUNDS.maxLists + 1,
            settings: 0,
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("summary helpers", () => {
  it("starts every count at zero", () => {
    const summary = emptyGuestMergeSummary();
    expect(Object.values(summary).every((value) => value === 0)).toBe(true);
    expect(summaryChangedAnything(summary)).toBe(false);
  });

  it("does NOT call a merge of pure duplicates a change", () => {
    // A resubmission of an already-merged history is honestly a no-op. Counting
    // duplicates as applied would tell the learner something untrue.
    const duplicatesOnly: GuestMergeSummary = {
      ...emptyGuestMergeSummary(),
      attemptsDuplicate: 40,
      eventsDuplicate: 40,
      bookmarksAlreadyPresent: 5,
      settingsKeptFromAccount: 4,
    };
    expect(summaryChangedAnything(duplicatesOnly)).toBe(false);
  });

  it("can report a rejected bookmark or setting rather than dropping it silently", () => {
    // §16 requires accurate merged/unchanged/REJECTED bookmark counts and §18
    // requires guest settings to be validated; without somewhere to put a
    // refusal, a learner told "20 bookmarks added" when 3 were invalid has been
    // given a number that is not true of anything.
    const withRejections: GuestMergeSummary = {
      ...emptyGuestMergeSummary(),
      bookmarksAdded: 17,
      bookmarksRejected: 3,
      settingsRejected: 2,
    };
    expect(withRejections.bookmarksRejected).toBe(3);
    expect(withRejections.settingsRejected).toBe(2);
    // A rejection is not an application.
    expect(
      summaryChangedAnything({
        ...emptyGuestMergeSummary(),
        bookmarksRejected: 3,
        settingsRejected: 2,
      }),
    ).toBe(false);
  });

  it("counts any genuinely applied item as a change", () => {
    for (const key of [
      "attemptsApplied",
      "eventsApplied",
      "bookmarksAdded",
      "listsCreated",
      "listsMerged",
      "settingsAdopted",
    ] as const) {
      expect(
        summaryChangedAnything({ ...emptyGuestMergeSummary(), [key]: 1 }),
      ).toBe(true);
    }
  });

  it("sums declared counts across every kind", () => {
    expect(
      totalDeclaredItems({
        attempts: 3,
        events: 3,
        bookmarks: 1,
        lists: 2,
        settings: 4,
      }),
    ).toBe(13);
  });
});
