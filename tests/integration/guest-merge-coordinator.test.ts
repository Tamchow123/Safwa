/**
 * Phase 17 §13–§15 — the staged merge coordinator end to end.
 *
 * Driven through `runGuestMerge` with real `begin`/`chunk`/`finalize` requests
 * against Postgres, because everything this slice promises — resumability,
 * idempotency, the cumulative list ceiling — is a claim about what SURVIVES
 * between requests, and none of it can be observed within one.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import {
  bookmarks,
  customLists,
  guestImportListMappings,
  guestImports,
  reviewEvents,
  studyComponents,
} from "@/db/schema";
import { loadVerifiedReleaseCached } from "@/modules/content/server-release-registry";
import {
  resolveComponentIdentity,
  type ResolvedComponentIdentity,
} from "@/modules/study-engine";
import {
  createQuestionContextFromRelease,
  generateQuestion,
  type QuestionContext,
  type QuestionInstance,
} from "@/modules/study-engine/generator";
import {
  emptyGuestMergeSummary,
  GUEST_MERGE_BOUNDS,
  SYNC_PROTOCOL_VERSION,
  type GuestMergeRequest,
  type GuestMergeResponse,
} from "@/modules/sync/protocol";
import { runGuestMerge } from "@/modules/sync/server/guest-merge";
import {
  makeGuestAttempt,
  makeGuestEvent,
  type GuestMergeFixture,
} from "@/tests/integration/helpers/guest-merge-fixtures";
import { createTestUser } from "@/tests/integration/helpers/users";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const SEED = "merge-coordinator-seed";
const SNAPSHOT = "a".repeat(64);

let releaseId: string;
let context: QuestionContext;
let identity: ResolvedComponentIdentity;
let instance: QuestionInstance;
let entryA: number;
let entryB: number;

beforeAll(async () => {
  const { registered } = await registerContent(getDb());
  releaseId = registered[0]!;
  const verified = await loadVerifiedReleaseCached(releaseId);
  context = createQuestionContextFromRelease(verified.learner);
  for (const entry of context.entries) {
    try {
      const candidate = resolveComponentIdentity({
        entryId: entry.id,
        skillType: "meaning_recognition",
        sourceField: "madi",
        direction: "arabic_to_english",
      });
      instance = generateQuestion(context, {
        identity: candidate,
        deliveryMode: "mc",
        questionSeed: SEED,
        position: 0,
      });
      identity = candidate;
      break;
    } catch {
      // try the next entry
    }
  }
  if (!identity) throw new Error("no generatable component in the release");
  const ids = context.entries.map((e) => e.id).sort((a, b) => a - b);
  [entryA, entryB] = ids as [number, number];
});

function run(userId: string, request: GuestMergeRequest) {
  return runGuestMerge(userId, request, { nowMs: NOW, registryDir: undefined });
}

type BeginOverrides = Omit<
  Partial<Extract<GuestMergeRequest, { stage: "begin" }>>,
  "declared"
> & {
  /** Partial: unmentioned kinds default to zero (see the merge below). */
  declared?: Partial<
    Extract<GuestMergeRequest, { stage: "begin" }>["declared"]
  >;
};

function beginRequest(
  importKey: string,
  overrides: BeginOverrides = {},
): GuestMergeRequest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "begin",
    importKey,
    snapshotHash: SNAPSHOT,
    deviceId: "device-1",
    ...overrides,
    // AFTER the spread: `overrides.declared` is a partial, so letting it land
    // whole would drop the kinds it does not mention and make the declared
    // total NaN. Merged over the zeroed base instead.
    declared: {
      attempts: 0,
      events: 0,
      bookmarks: 0,
      lists: 0,
      settings: 0,
      ...overrides.declared,
    },
  } as GuestMergeRequest;
}

function chunkRequest(
  importKey: string,
  chunkIndex: number,
  body: Partial<Extract<GuestMergeRequest, { stage: "chunk" }>> = {},
): GuestMergeRequest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "chunk",
    importKey,
    snapshotHash: SNAPSHOT,
    chunkIndex,
    attempts: [],
    events: [],
    bookmarks: [],
    lists: [],
    settings: [],
    ...body,
  } as GuestMergeRequest;
}

function finalizeRequest(
  importKey: string,
  snapshotHash = SNAPSHOT,
): GuestMergeRequest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "finalize",
    importKey,
    snapshotHash,
  };
}

function guestBookmark(entryId: number) {
  return { entryId, createdAt: 1_700_000_000_000, deleted: false };
}

function guestList(name: string, entryIds: number[]) {
  return {
    id: randomUUID(),
    name,
    entryIds,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deleted: false,
  };
}

/** The suite's chosen question, for the shared builders. */
function fixture(): GuestMergeFixture {
  return {
    identity,
    instance,
    releaseId,
    contentVersion: context.contentVersion,
    seed: SEED,
  };
}

function guestAttempt(id: string, sessionId: string) {
  return makeGuestAttempt(fixture(), id, sessionId);
}

function guestEvent(
  eventId: string,
  attemptId: string,
  sessionId: string,
  parentEventId: string | null,
  revision: number,
  occurredAtClient: string,
) {
  return makeGuestEvent(
    fixture(),
    eventId,
    attemptId,
    sessionId,
    parentEventId,
    revision,
    occurredAtClient,
  );
}

async function importRow(importKey: string) {
  const [row] = await getDb()
    .select()
    .from(guestImports)
    .where(eq(guestImports.importKey, importKey));
  return row;
}

function asBegin(response: GuestMergeResponse) {
  if (response.stage !== "begin") throw new Error("expected a begin response");
  return response;
}
function asChunk(response: GuestMergeResponse) {
  if (response.stage !== "chunk") throw new Error("expected a chunk response");
  return response;
}
function asFinalize(response: GuestMergeResponse) {
  if (response.stage !== "finalize")
    throw new Error("expected a finalize response");
  return response;
}

describe("begin — claiming an import key (§12, §15)", () => {
  it("claims a fresh key and starts the client at chunk 0", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();

    const response = asBegin(
      await run(
        userId,
        beginRequest(importKey, { declared: { bookmarks: 2 } }),
      ),
    );

    expect(response.reasonCode).toBe("accepted");
    expect(response.importStatus).toBe("open");
    expect(response.resumeFromChunk).toBe(0);
    expect(response.acceptedItems).toBe(0);

    const row = await importRow(importKey);
    expect(row?.declaredItems).toBe(2);
    expect(row?.status).toBe("open");
  });

  it("resumes an open key at the chunk it reached, rather than restarting it", async () => {
    // The whole reason the protocol is staged: an interruption should cost the
    // chunks not yet sent, not the history.
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 2 } }));
    await run(
      userId,
      chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
    );

    const resumed = asBegin(
      await run(
        userId,
        beginRequest(importKey, { declared: { bookmarks: 2 } }),
      ),
    );
    expect(resumed.reasonCode).toBe("accepted");
    expect(resumed.resumeFromChunk).toBe(1);
    expect(resumed.acceptedItems).toBe(1);
  });

  it("refuses a key bound to a DIFFERENT snapshot (§12)", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey));

    const response = asBegin(
      await run(
        userId,
        beginRequest(importKey, { snapshotHash: "b".repeat(64) }),
      ),
    );
    expect(response.reasonCode).toBe("snapshot_mismatch");
  });

  it("refuses a key that belongs to another account, revealing nothing about it (§15)", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const importKey = randomUUID();
    await run(owner, beginRequest(importKey, { declared: { bookmarks: 5 } }));
    await run(
      owner,
      chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
    );

    const response = asBegin(await run(stranger, beginRequest(importKey)));
    expect(response.reasonCode).toBe("cross_account_import");
    // Nothing about the owner's progress leaks through the response.
    expect(response.resumeFromChunk).toBe(0);
    expect(response.acceptedItems).toBe(0);
    expect(response.summary).toBeUndefined();
  });

  it("returns the STORED summary for a completed key without merging again (§12, §15)", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 1 } }));
    await run(
      userId,
      chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
    );
    await run(userId, finalizeRequest(importKey));

    const response = asBegin(
      await run(
        userId,
        beginRequest(importKey, { declared: { bookmarks: 1 } }),
      ),
    );
    expect(response.reasonCode).toBe("already_completed");
    expect(response.importStatus).toBe("completed");
    expect(response.summary?.bookmarksAdded).toBe(1);
  });
});

describe("chunk — carrying the history in (§13, §14)", () => {
  it("applies a chunk's items and advances the resume point", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 2 } }));

    const response = asChunk(
      await run(
        userId,
        chunkRequest(importKey, 0, {
          bookmarks: [guestBookmark(entryA), guestBookmark(entryB)],
        }),
      ),
    );

    expect(response.reasonCode).toBe("accepted");
    expect(response.acceptedItems).toBe(2);
    expect(response.results).toHaveLength(2);

    const rows = await getDb()
      .select({ entryId: bookmarks.entryId })
      .from(bookmarks)
      .where(eq(bookmarks.userId, userId));
    expect(rows.map((r) => r.entryId).sort((a, b) => a - b)).toEqual(
      [entryA, entryB].sort((a, b) => a - b),
    );
  });

  it("refuses a chunk that skips ahead, so a gap cannot pass as complete", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 2 } }));

    const response = asChunk(
      await run(
        userId,
        chunkRequest(importKey, 3, { bookmarks: [guestBookmark(entryA)] }),
      ),
    );
    expect(response.reasonCode).toBe("chunk_out_of_range");
    expect(response.acceptedItems).toBe(0);
  });

  it("treats a re-sent chunk as already applied instead of counting it twice", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 1 } }));
    const body = chunkRequest(importKey, 0, {
      bookmarks: [guestBookmark(entryA)],
    });

    const first = asChunk(await run(userId, body));
    expect(first.acceptedItems).toBe(1);

    const second = asChunk(await run(userId, body));
    expect(second.reasonCode).toBe("accepted");
    // The count is the import's, not this request's: re-sending must not make
    // the progress denominator drift above what was really accepted.
    expect(second.acceptedItems).toBe(1);
  });

  it("refuses a chunk for a key that was never begun", async () => {
    const userId = await createTestUser();
    const response = asChunk(
      await run(userId, chunkRequest(randomUUID(), 0, {})),
    );
    expect(response.reasonCode).toBe("unknown_import");
  });

  it("refuses a chunk under a mismatched snapshot on arrival, not at finalisation", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 1 } }));

    const response = asChunk(
      await run(userId, {
        ...chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
        snapshotHash: "c".repeat(64),
      } as GuestMergeRequest),
    );
    expect(response.reasonCode).toBe("snapshot_mismatch");
    // And nothing from the mismatched chunk was stored.
    const rows = await getDb()
      .select({ entryId: bookmarks.entryId })
      .from(bookmarks)
      .where(eq(bookmarks.userId, userId));
    expect(rows).toEqual([]);
  });
});

describe("chunk — guest scheduling history through the merge ingestion mode (§14)", () => {
  it("ingests a guest chain under the import's provenance and counts what the SERVER decided", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(
      userId,
      beginRequest(importKey, { declared: { events: 2, attempts: 2 } }),
    );

    const [a1, a2] = [randomUUID(), randomUUID()];
    const [s1, s2] = [randomUUID(), randomUUID()];
    const [e1, e2] = [randomUUID(), randomUUID()];

    const response = asChunk(
      await run(
        userId,
        chunkRequest(importKey, 0, {
          attempts: [guestAttempt(a1, s1), guestAttempt(a2, s2)],
          events: [
            guestEvent(e1, a1, s1, null, 1, "2026-07-20T09:00:00.000Z"),
            guestEvent(e2, a2, s2, e1, 2, "2026-07-20T09:30:00.000Z"),
          ],
        }),
      ),
    );
    expect(response.reasonCode).toBe("accepted");

    // Every event carries the import's provenance — the marker that makes the
    // union lineage rule apply to it and to nothing else (§14).
    const events = await getDb()
      .select({
        eventId: reviewEvents.eventId,
        status: reviewEvents.status,
        importedFrom: reviewEvents.importedFromGuestImportId,
      })
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    expect(events).toHaveLength(2);
    const row = await importRow(importKey);
    // Load-bearing: without it, an import row that was never written would make
    // `row?.id` undefined, and the comparison below would be asserting that the
    // events are stamped with nothing in particular.
    expect(row).toBeDefined();
    for (const event of events) {
      expect(event.status).toBe("scheduling");
      expect(event.importedFrom).toBe(row!.id);
    }

    // The summary counts the server's decisions, not the client's claims.
    expect(row?.eventCount).toBe(2);
    expect(row?.attemptCount).toBe(2);
    const summary = row?.summary as Record<string, number>;
    expect(summary.eventsApplied).toBe(2);
    expect(summary.eventsRejected).toBe(0);
    expect(summary.componentsAffected).toBe(1);
  });

  it("unions a guest chain onto a component the account already has history on", async () => {
    // The case §14 exists for: two histories, one component. The account's
    // chain is built first through the coordinator, then a SECOND import brings
    // a chain that roots independently.
    const userId = await createTestUser();

    const accountKey = randomUUID();
    await run(
      userId,
      beginRequest(accountKey, { declared: { events: 1, attempts: 1 } }),
    );
    const [aA, sA, eA] = [randomUUID(), randomUUID(), randomUUID()];
    await run(
      userId,
      chunkRequest(accountKey, 0, {
        attempts: [guestAttempt(aA, sA)],
        events: [guestEvent(eA, aA, sA, null, 1, "2026-07-20T10:00:00.000Z")],
      }),
    );
    await run(userId, finalizeRequest(accountKey));

    const guestKey = randomUUID();
    await run(userId, {
      ...beginRequest(guestKey, { declared: { events: 1, attempts: 1 } }),
      snapshotHash: "d".repeat(64),
    } as GuestMergeRequest);
    const [aG, sG, eG] = [randomUUID(), randomUUID(), randomUUID()];
    const response = asChunk(
      await run(userId, {
        ...chunkRequest(guestKey, 0, {
          attempts: [guestAttempt(aG, sG)],
          // A second ROOT: ordinary sync would call this a stale branch.
          events: [guestEvent(eG, aG, sG, null, 1, "2026-07-20T08:00:00.000Z")],
        }),
        snapshotHash: "d".repeat(64),
      } as GuestMergeRequest),
    );

    expect(response.results.find((r) => r.itemId === eG)).toMatchObject({
      status: "accepted",
    });

    // The union was authorised in the same transaction that created it.
    const [component] = await getDb()
      .select({
        mergedAt: studyComponents.mergedAt,
        mergedFrom: studyComponents.mergedFromGuestImportId,
        reps: studyComponents.reps,
      })
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.mergedAt).not.toBeNull();
    expect(component?.mergedFrom).toBe((await importRow(guestKey))?.id);
    expect(component?.reps).toBe(2);
  });
});

describe("SEC-003 — the CUMULATIVE list ceiling", () => {
  it("refuses the excess rather than truncating the mappings it owes the client", async () => {
    // The per-chunk schema cannot bound this: maxChunks x SYNC_BOUNDS.maxLists
    // allows far more list items across an import than the ceiling. Only a
    // running count that survives between requests can, which is what
    // `guest_imports.accepted_lists` is for.
    //
    // Truncating instead would orphan the guest list ids beyond the cap on the
    // client, breaking the re-keying §17 guarantees — so the excess is REFUSED.
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { lists: 10 } }));

    // Drive `accepted_lists` to the ceiling without sending 500 real lists.
    await getDb()
      .update(guestImports)
      .set({ acceptedLists: GUEST_MERGE_BOUNDS.maxLists })
      .where(eq(guestImports.importKey, importKey));

    const response = asChunk(
      await run(
        userId,
        chunkRequest(importKey, 0, {
          lists: [guestList("One list past the ceiling", [entryA])],
        }),
      ),
    );

    expect(response.reasonCode).toBe("list_ceiling_exceeded");
    expect(response.importStatus).toBe("rejected");

    // The refusal is DURABLE, and it says why — that is what the 0005
    // reason_code column exists for.
    const row = await importRow(importKey);
    expect(row?.status).toBe("rejected");
    expect(row?.result).toBe("rejected");
    expect(row?.reasonCode).toBe("list_ceiling_exceeded");
    // And the over-ceiling list was not created.
    const lists = await getDb()
      .select({ id: customLists.id })
      .from(customLists)
      .where(eq(customLists.userId, userId));
    expect(lists).toEqual([]);
  });

  it("tells a returning client why the key was refused, not merely that it was", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { lists: 1 } }));
    await getDb()
      .update(guestImports)
      .set({ acceptedLists: GUEST_MERGE_BOUNDS.maxLists })
      .where(eq(guestImports.importKey, importKey));
    await run(
      userId,
      chunkRequest(importKey, 0, { lists: [guestList("Excess", [entryA])] }),
    );

    const response = asBegin(
      await run(userId, beginRequest(importKey, { declared: { lists: 1 } })),
    );
    expect(response.reasonCode).toBe("list_ceiling_exceeded");
    expect(response.importStatus).toBe("rejected");
  });

  it("counts lists cumulatively ACROSS chunks, not per chunk", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { lists: 2 } }));

    await run(
      userId,
      chunkRequest(importKey, 0, { lists: [guestList("First", [entryA])] }),
    );
    let row = await importRow(importKey);
    expect(row?.acceptedLists).toBe(1);

    await run(
      userId,
      chunkRequest(importKey, 1, { lists: [guestList("Second", [entryB])] }),
    );
    row = await importRow(importKey);
    // Two chunks, one list each: the running total is what the ceiling is
    // measured against, and it is genuinely running.
    expect(row?.acceptedLists).toBe(2);
  });
});

describe("finalize — concluding honestly (§13, §15, §29)", () => {
  it("reports `applied` and completes the row when everything declared arrived", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 1 } }));
    await run(
      userId,
      chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
    );

    const response = asFinalize(await run(userId, finalizeRequest(importKey)));
    expect(response.result).toBe("applied");
    expect(response.reasonCode).toBe("accepted");
    expect(response.summary.bookmarksAdded).toBe(1);
    expect(response.activeReleaseId).toBe(releaseId);
    expect(response.serverCursor).toBeGreaterThan(0);

    const row = await importRow(importKey);
    expect(row?.status).toBe("completed");
    expect(row?.result).toBe("applied");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.finalServerCursor).toBeGreaterThan(0);
  });

  it("reports `incomplete` and stays OPEN when the upload was truncated (§29)", async () => {
    // Neither "succeeded" nor "rolled back" would be true, and §29 forbids
    // claiming either. The client must be able to resume under the same key.
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 5 } }));
    await run(
      userId,
      chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
    );

    const response = asFinalize(await run(userId, finalizeRequest(importKey)));
    expect(response.result).toBe("incomplete");
    expect(response.reasonCode).toBe("incomplete_upload");

    const row = await importRow(importKey);
    expect(row?.status).toBe("open"); // resumable, not failed
    expect(row?.result).toBe("incomplete");
    expect(row?.completedAt).toBeNull();

    // And resuming really works: the remaining chunk still lands.
    const resumed = asBegin(
      await run(
        userId,
        beginRequest(importKey, { declared: { bookmarks: 5 } }),
      ),
    );
    expect(resumed.resumeFromChunk).toBe(1);
  });

  it("reports `no_op` when the chunks turned out to change nothing", async () => {
    // Same key, but the account already held everything in it — e.g. the merge
    // completed and the response was lost, and the client re-uploaded before
    // finalising. `applied` would claim a change the learner would not find.
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 1 } }));
    // Put the bookmark on the account first, so the chunk has nothing to add.
    await run(
      userId,
      chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
    );
    await getDb()
      .update(guestImports)
      .set({ summary: emptyGuestMergeSummary(), acceptedItems: 1 })
      .where(eq(guestImports.importKey, importKey));

    const response = asFinalize(await run(userId, finalizeRequest(importKey)));
    expect(response.result).toBe("no_op");
  });

  it("short-circuits a NEW key carrying an already-merged snapshot, before re-uploading it", async () => {
    // §15 makes one completion per (account, snapshot) a database invariant, so
    // a client that lost its key and minted a new one for a history the account
    // already holds must be told at `begin` — not after re-sending the whole
    // history and failing the unique index at finalisation.
    const userId = await createTestUser();
    const first = randomUUID();
    await run(userId, beginRequest(first, { declared: { bookmarks: 1 } }));
    await run(
      userId,
      chunkRequest(first, 0, { bookmarks: [guestBookmark(entryA)] }),
    );
    const original = asFinalize(await run(userId, finalizeRequest(first)));
    expect(original.result).toBe("applied");

    const second = randomUUID();
    const response = asBegin(
      await run(userId, beginRequest(second, { declared: { bookmarks: 1 } })),
    );

    expect(response.reasonCode).toBe("already_completed");
    expect(response.importStatus).toBe("completed");
    // The numbers are the ORIGINAL merge's, so the learner sees what really
    // happened rather than a second set of zeroes.
    expect(response.summary).toEqual(original.summary);
    // And no second row was claimed for the duplicate key.
    expect(await importRow(second)).toBeUndefined();
  });

  it("returns the stored result on a second finalisation without applying again", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { bookmarks: 1 } }));
    await run(
      userId,
      chunkRequest(importKey, 0, { bookmarks: [guestBookmark(entryA)] }),
    );
    const first = asFinalize(await run(userId, finalizeRequest(importKey)));
    const second = asFinalize(await run(userId, finalizeRequest(importKey)));

    expect(second.result).toBe(first.result);
    expect(second.reasonCode).toBe("already_completed");
    expect(second.summary).toEqual(first.summary);
  });

  it("refuses finalisation of a key that was never begun", async () => {
    const userId = await createTestUser();
    const response = asFinalize(
      await run(userId, finalizeRequest(randomUUID())),
    );
    expect(response.result).toBe("rejected");
    expect(response.reasonCode).toBe("unknown_import");
  });

  it("returns the guest→account list id mappings the client needs to re-key (§17)", async () => {
    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { lists: 1 } }));
    const list = guestList("Weak verbs", [entryA]);
    await run(userId, chunkRequest(importKey, 0, { lists: [list] }));

    const response = asFinalize(await run(userId, finalizeRequest(importKey)));
    expect(response.listIdMappings).toEqual([
      { guestListId: list.id, accountListId: list.id },
    ]);
  });

  it("returns a RE-MINTED mapping that no in-process state could have carried", async () => {
    // The case three reviewers rejected an in-memory accumulator over. The
    // mapping is produced by `chunk` and consumed by `finalize` — separate HTTP
    // requests, served on this deployment by different serverless instances —
    // and it cannot be recomputed afterwards, because a completed import
    // refuses to re-apply its chunks.
    //
    // The re-minted branch is the one that matters: when the guest uuid is free
    // the mapping is the identity and a client could survive losing it, but
    // when the id was taken only the stored pair says where the list went.
    //
    // Read back from the database with NO reliance on anything the chunk left
    // in memory — the assertion below is against `guest_import_list_mappings`
    // as well as the response, so it fails if the value is ever process-local.
    const other = await createTestUser();
    const contested = guestList("Someone else's list", [entryA]);
    await run(other, beginRequest(randomUUID(), { declared: { lists: 1 } }));
    const otherKey = randomUUID();
    await run(other, beginRequest(otherKey, { declared: { lists: 1 } }));
    await run(other, chunkRequest(otherKey, 0, { lists: [contested] }));

    const userId = await createTestUser();
    const importKey = randomUUID();
    await run(userId, beginRequest(importKey, { declared: { lists: 1 } }));
    // Same uuid, different account: the server must mint a fresh id.
    const mine = { ...guestList("My own list", [entryB]), id: contested.id };
    await run(userId, chunkRequest(importKey, 0, { lists: [mine] }));

    const response = asFinalize(await run(userId, finalizeRequest(importKey)));
    expect(response.listIdMappings).toHaveLength(1);
    const mapping = response.listIdMappings[0]!;
    expect(mapping.guestListId).toBe(mine.id);
    expect(mapping.accountListId).not.toBe(mine.id);

    // The same pair is on disk, keyed to the import — which is the only reason
    // finalize could have produced it at all.
    const persisted = await getDb()
      .select({
        guestListId: guestImportListMappings.guestListId,
        accountListId: guestImportListMappings.accountListId,
      })
      .from(guestImportListMappings)
      .where(
        eq(guestImportListMappings.importId, (await importRow(importKey))!.id),
      );
    expect(persisted).toEqual([mapping]);
  });

  it("serialises two keys finalising one snapshot instead of surfacing a constraint error", async () => {
    // REL-003. `guest_imports_user_snapshot_completed_idx` admits one completion
    // per (account, snapshot). Checking for the other key first is check-then-act
    // — both would see none and the loser would throw a raw 23505 — so
    // finalisation takes an advisory lock on (account, snapshot). Exactly one
    // key completes; the other is told the history is already there.
    const userId = await createTestUser();
    const keyA = randomUUID();
    const keyB = randomUUID();

    for (const key of [keyA, keyB]) {
      await run(userId, beginRequest(key, { declared: { bookmarks: 1 } }));
      await run(
        userId,
        chunkRequest(key, 0, { bookmarks: [guestBookmark(entryA)] }),
      );
    }

    // Both eligible to finalise, fired together.
    const [first, second] = await Promise.all([
      run(userId, finalizeRequest(keyA)).then(asFinalize),
      run(userId, finalizeRequest(keyB)).then(asFinalize),
    ]);

    // Neither threw, and neither is an internal error.
    for (const response of [first, second]) {
      expect(response.reasonCode).not.toBe("internal_error");
    }
    // Exactly one import row completed.
    const rows = await getDb()
      .select({ status: guestImports.status })
      .from(guestImports)
      .where(eq(guestImports.userId, userId));
    expect(rows.filter((r) => r.status === "completed")).toHaveLength(1);
    // And the loser was told the history is already on the account.
    const outcomes = [first.reasonCode, second.reasonCode].sort();
    expect(outcomes).toEqual(["accepted", "already_completed"]);
  });
});
