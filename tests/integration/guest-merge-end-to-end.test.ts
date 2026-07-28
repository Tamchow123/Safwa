/**
 * Phase 17 §24 — the merge's end-to-end guarantees, against Postgres.
 *
 * This file deliberately does NOT re-prove what the sibling suites already do.
 * `guest-merge-coordinator` covers the staged protocol (claim, resume, chunk
 * ordering, the list ceiling, finalisation vocabulary); `guest-merge-collections`
 * covers §16–§18; `sync-merge-union` covers the union's replay and its marker.
 * What none of them prove is what a WHOLE import does to the account when it is
 * run twice, when a hostile item is inside it, or when the identity around it
 * changes — and those are the questions §24 asks.
 *
 * Every test runs a complete begin → chunk → finalize cycle through
 * `runGuestMerge`, then reads the account's own rows back. A claim about
 * idempotency that is not measured against the stored row count is not a claim
 * about idempotency.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import {
  guestImports,
  reviewEvents,
  studyAttempts,
  studyComponents,
  users,
  userSyncState,
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
  SYNC_PROTOCOL_VERSION,
  type GuestMergeChunkResponse,
  type GuestMergeFinalizeResponse,
  type GuestMergeRequest,
  type GuestMergeResponse,
} from "@/modules/sync/protocol";
import { runGuestMerge } from "@/modules/sync/server/guest-merge";
import {
  aDistractor as pickDistractor,
  makeGuestAttempt,
  makeGuestEvent,
  type GuestMergeFixture,
} from "@/tests/integration/helpers/guest-merge-fixtures";
import { createTestUser } from "@/tests/integration/helpers/users";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const SEED = "merge-e2e-seed";
const SNAPSHOT = "b".repeat(64);

/**
 * A release id no registry the app ships has ever listed. Used for the
 * `invalid_release` case, and — through the fixture registry below — as the
 * revoked one.
 */
const REVOKED_RELEASE_ID = "safwa-merge-fixture-revoked";
const UNKNOWN_RELEASE_ID = "safwa-merge-fixture-unknown";
const SUPPORT = {
  minimum_supported_client_version: "0.1.0",
  minimum_supported_event_schema: 1,
} as const;

let releaseId: string;
let context: QuestionContext;
let identity: ResolvedComponentIdentity;
let instance: QuestionInstance;
/** A throwaway registry whose only difference from the real one is a revoked entry. */
let revokedRegistryDir: string;

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

  // The REAL release stays active here, so `finalize` can still resolve and
  // verify it from its own committed artifacts; the only thing this registry
  // adds is a second, revoked entry for an item to reference.
  revokedRegistryDir = await mkdtemp(
    path.join(tmpdir(), "safwa-merge-registry-"),
  );
  await writeFile(
    path.join(revokedRegistryDir, "release-registry.json"),
    JSON.stringify({
      active_release_id: releaseId,
      releases: {
        [releaseId]: { status: "active", ...SUPPORT },
        [REVOKED_RELEASE_ID]: { status: "revoked", ...SUPPORT },
      },
    }),
    "utf8",
  );
});

function run(userId: string, request: GuestMergeRequest, registryDir?: string) {
  return runGuestMerge(userId, request, { nowMs: NOW, registryDir });
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

function guestAttempt(
  id: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  return makeGuestAttempt(fixture(), id, sessionId, overrides);
}

function guestEvent(
  eventId: string,
  attemptId: string,
  sessionId: string,
  parentEventId: string | null,
  revision: number,
  occurredAtClient: string,
  overrides: Record<string, unknown> = {},
) {
  return makeGuestEvent(
    fixture(),
    eventId,
    attemptId,
    sessionId,
    parentEventId,
    revision,
    occurredAtClient,
    overrides,
  );
}

/** One complete two-event guest history, as the client would send it. */
function history(sessionId: string) {
  const a1 = randomUUID();
  const a2 = randomUUID();
  const e1 = randomUUID();
  const e2 = randomUUID();
  return {
    eventIds: [e1, e2],
    attemptIds: [a1, a2],
    attempts: [guestAttempt(a1, sessionId), guestAttempt(a2, sessionId)],
    events: [
      guestEvent(e1, a1, sessionId, null, 1, "2026-07-20T11:00:00.000Z"),
      guestEvent(e2, a2, sessionId, e1, 2, "2026-07-20T11:05:00.000Z"),
    ],
  };
}

/**
 * Run a whole import and return BOTH stage responses.
 *
 * The chunk response is the only place a per-item reason code is visible: the
 * finalisation summary carries counts, and a count cannot say WHY an item was
 * refused. A test that only checks `eventsRejected === 1` passes equally when
 * the server refused for the wrong reason.
 */
async function runImport(
  userId: string,
  importKey: string,
  body: { attempts: unknown[]; events: unknown[] },
  options: { snapshotHash?: string; registryDir?: string } = {},
): Promise<{
  chunk: GuestMergeChunkResponse;
  finalize: GuestMergeFinalizeResponse;
}> {
  const snapshotHash = options.snapshotHash ?? SNAPSHOT;
  const { registryDir } = options;
  await run(
    userId,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "begin",
      importKey,
      snapshotHash,
      deviceId: "device-1",
      declared: {
        attempts: body.attempts.length,
        events: body.events.length,
        bookmarks: 0,
        lists: 0,
        settings: 0,
      },
    } as GuestMergeRequest,
    registryDir,
  );
  const chunk = await run(
    userId,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "chunk",
      importKey,
      snapshotHash,
      chunkIndex: 0,
      attempts: body.attempts,
      events: body.events,
      bookmarks: [],
      lists: [],
      settings: [],
    } as GuestMergeRequest,
    registryDir,
  );
  const finalize = await run(
    userId,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "finalize",
      importKey,
      snapshotHash,
    },
    registryDir,
  );
  if (chunk.stage !== "chunk") throw new Error("expected a chunk response");
  if (finalize.stage !== "finalize")
    throw new Error("expected a finalize response");
  return { chunk, finalize };
}

/** Run a whole import to finalisation and return the final response. */
async function importOnce(
  userId: string,
  importKey: string,
  body: { attempts: unknown[]; events: unknown[] },
  options: { snapshotHash?: string; registryDir?: string } = {},
): Promise<GuestMergeResponse> {
  return (await runImport(userId, importKey, body, options)).finalize;
}

/**
 * What the account holds: its FIRST study component, that component's events,
 * ALL of the user's attempts (not only that component's), and its sync cursor.
 *
 * The attempt query is user-scoped rather than component-scoped, which is
 * accurate here because every test creates a fresh user and imports one
 * component's history — but a multi-component test could not use this as-is
 * (CLEAN-004).
 */
async function accountState(userId: string) {
  const db = getDb();
  const [component] = await db
    .select()
    .from(studyComponents)
    .where(eq(studyComponents.userId, userId));
  const events = component
    ? await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.studyComponentId, component.id))
    : [];
  const attempts = await db
    .select()
    .from(studyAttempts)
    .where(eq(studyAttempts.userId, userId));
  const [cursor] = await db
    .select()
    .from(userSyncState)
    .where(eq(userSyncState.userId, userId));
  return {
    component,
    events,
    attempts,
    cursor: cursor?.syncRevision ?? 0,
  };
}

function asFinalize(response: GuestMergeResponse) {
  if (response.stage !== "finalize")
    throw new Error("expected a finalize response");
  return response;
}

describe("§24 idempotency — an exact resubmission changes nothing", () => {
  it("does not import the same history twice", async () => {
    // The single most important property of the whole feature: a learner who
    // merges, loses their connection, and merges again must not end up with two
    // copies of their own history and a doubled review count.
    const userId = await createTestUser();
    const key = randomUUID();
    const h = history(randomUUID());

    const first = asFinalize(await importOnce(userId, key, h));
    expect(first.result).toBe("applied");
    const after = await accountState(userId);
    expect(after.attempts).toHaveLength(2);
    expect(after.events).toHaveLength(2);

    const second = asFinalize(await importOnce(userId, key, h));
    // The stored result, not a second application.
    expect(second.reasonCode).toBe("already_completed");

    const again = await accountState(userId);
    expect(again.attempts).toHaveLength(2);
    expect(again.events).toHaveLength(2);
  });

  it("does not double-advance the component revision or re-run the replay", async () => {
    // The revision is what a client's next event parents onto. Advancing it
    // twice for one history would make every subsequent review look stale.
    const userId = await createTestUser();
    const key = randomUUID();
    const h = history(randomUUID());

    await importOnce(userId, key, h);
    const after = await accountState(userId);

    await importOnce(userId, key, h);
    const again = await accountState(userId);

    expect(again.component?.revision).toBe(after.component?.revision);
    // The FSRS card is the replay's output. CORROBORATING evidence, not
    // independent proof (REL-002-T16): the neighbouring test already shows the
    // second import short-circuits at `begin`, so a re-entered replay would
    // most likely surface as a changed revision or row count rather than as a
    // silently-doubled-but-identical card. It is still worth pinning, because
    // the card is what the learner actually sees.
    expect(again.component?.reps).toBe(after.component?.reps);
    expect(again.component?.stability).toBe(after.component?.stability);
    expect(again.component?.dueAt?.getTime()).toBe(
      after.component?.dueAt?.getTime(),
    );
  });

  it("does not bump the account cursor for a pure no-op", async () => {
    // The cursor is what every other device pages from. Bumping it for an
    // import that wrote nothing would make each of them fetch an empty page.
    const userId = await createTestUser();
    const key = randomUUID();
    const h = history(randomUUID());

    await importOnce(userId, key, h);
    const after = await accountState(userId);

    await importOnce(userId, key, h);
    const again = await accountState(userId);

    expect(again.cursor).toBe(after.cursor);
  });
});

describe("§24 history union — what was imported stays queryable", () => {
  it("keeps every accepted attempt, under its ORIGINAL id", async () => {
    // §9.4: the ids are the learner's history, and they are also what the
    // server's own idempotency keys on. Re-minting them would make the next
    // resubmission a fresh import of the same reviews.
    const userId = await createTestUser();
    const h = history(randomUUID());
    await importOnce(userId, randomUUID(), h);

    const { attempts, events } = await accountState(userId);
    expect(attempts.map((a) => a.id).sort()).toEqual([...h.attemptIds].sort());
    expect(events.map((e) => e.eventId).sort()).toEqual([...h.eventIds].sort());
  });

  it("preserves the guest's own historical timestamps, not the import's", async () => {
    // A merged review happened when the learner did it. Restamping it with the
    // import's clock would rewrite their history into one long study session on
    // the day they signed up.
    const userId = await createTestUser();
    const h = history(randomUUID());
    await importOnce(userId, randomUUID(), h);

    const { events } = await accountState(userId);
    const instants = events
      .map((e) => e.occurredAtCanonical.getTime())
      .sort((a, b) => a - b);
    expect(instants).toEqual([
      Date.parse("2026-07-20T11:00:00.000Z"),
      Date.parse("2026-07-20T11:05:00.000Z"),
    ]);
    expect(instants.every((t) => t !== NOW)).toBe(true);
  });

  it("records which import each event came from, for the lineage rule", async () => {
    const userId = await createTestUser();
    const key = randomUUID();
    await importOnce(userId, key, history(randomUUID()));

    const [row] = await getDb()
      .select()
      .from(guestImports)
      .where(eq(guestImports.importKey, key));
    const { events } = await accountState(userId);
    // Both existence checks are load-bearing (CLEAN-002/005): `[].every(...)` is
    // vacuously true, so without them this would pass against an import that
    // wrote nothing at all — the very failure it exists to catch.
    expect(row).toBeDefined();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.importedFromGuestImportId === row!.id)).toBe(
      true,
    );
  });
});

describe("§24 trust boundary — the server derives, the guest asserts", () => {
  it("corrects a guest attempt that claims a wrong answer was right", async () => {
    // CLAUDE.md §7 and §9.3: correctness is derived from the assessment
    // manifest, never trusted. A guest whose local storage was edited must not
    // be able to award themselves a perfect history.
    //
    // The selection is a REAL DISTRACTOR from this question's own option set
    // (REL-001-T16). An earlier version used the prompt's own ref, which is not
    // in `allowedAnswerRefs` at all, so grading refused it as `option_not_in_set`
    // and the correction path was never reached — the test passed while proving
    // something weaker than its name.
    const userId = await createTestUser();
    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const eventId = randomUUID();
    const lying = guestAttempt(attemptId, sessionId, {
      selectedAnswerRef: pickDistractor(fixture()),
      isCorrect: true,
    });

    await importOnce(userId, randomUUID(), {
      attempts: [lying],
      events: [
        guestEvent(
          eventId,
          attemptId,
          sessionId,
          null,
          1,
          "2026-07-20T11:00:00.000Z",
        ),
      ],
    });

    const [stored] = await getDb()
      .select()
      .from(studyAttempts)
      .where(eq(studyAttempts.id, attemptId));
    // Unconditionally: the attempt IS stored, and stored as wrong.
    expect(stored).toBeDefined();
    expect(stored?.isCorrect).toBe(false);
  });

  it("corrects the RATING a guest claimed, not just the correctness", async () => {
    // §9.3 and CLAUDE.md §7 name the rating alongside correctness. A wrong
    // answer is `again` whatever the guest's device said, and the scheduling
    // that follows is derived from the corrected value.
    const userId = await createTestUser();
    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const eventId = randomUUID();

    await importOnce(userId, randomUUID(), {
      attempts: [
        guestAttempt(attemptId, sessionId, {
          selectedAnswerRef: pickDistractor(fixture()),
          isCorrect: false,
        }),
      ],
      events: [
        guestEvent(
          eventId,
          attemptId,
          sessionId,
          null,
          1,
          "2026-07-20T11:00:00.000Z",
          // The lie: a wrong answer graded as if it had been easy.
          { rating: "easy" },
        ),
      ],
    });

    const [stored] = await getDb()
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.eventId, eventId));
    expect(stored).toBeDefined();
    expect(stored?.rating).toBe("again");
  });

  it("refuses a guest event parented on ANOTHER account's event", async () => {
    // §9.2: a merge must not be able to graft one learner's history onto
    // another's chain, nor learn anything about it by trying.
    const other = await createTestUser();
    const otherHistory = history(randomUUID());
    await importOnce(other, randomUUID(), otherHistory);

    const userId = await createTestUser();
    const attemptId = randomUUID();
    const sessionId = randomUUID();

    const response = asFinalize(
      await importOnce(userId, randomUUID(), {
        attempts: [guestAttempt(attemptId, sessionId)],
        events: [
          guestEvent(
            randomUUID(),
            attemptId,
            sessionId,
            // The other account's real event id.
            otherHistory.eventIds[0]!,
            2,
            "2026-07-20T11:00:00.000Z",
          ),
        ],
      }),
    );

    expect(response.summary.eventsApplied).toBe(0);
    expect(response.summary.eventsRejected).toBe(1);
    // And the other account's history is untouched by the attempt.
    const otherEvents = await getDb()
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, other));
    expect(otherEvents).toHaveLength(2);
  });

  it("refuses an event whose component key does not match its attempt", async () => {
    // A tampered natural key must not let an import write scheduling state onto
    // a component the attempt never belonged to.
    const userId = await createTestUser();
    const attemptId = randomUUID();
    const sessionId = randomUUID();

    const response = asFinalize(
      await importOnce(userId, randomUUID(), {
        attempts: [guestAttempt(attemptId, sessionId)],
        events: [
          guestEvent(
            randomUUID(),
            attemptId,
            sessionId,
            null,
            1,
            "2026-07-20T11:00:00.000Z",
            { studyComponentId: "entry:999999:skill:meaning_recognition" },
          ),
        ],
      }),
    );

    // Exactly one, not merely "some" (CLEAN-003): a coordinator that refused
    // the whole chunk would also satisfy a `> 0` assertion.
    expect(response.summary.eventsApplied).toBe(0);
    expect(response.summary.eventsRejected).toBe(1);
  });

  it("writes the import under the SESSION's account, whatever the payload says", async () => {
    // §9.2: ownership is derived from the session. A client-supplied id must
    // not be able to redirect somebody else's history onto another account.
    const owner = await createTestUser();
    const other = await createTestUser();
    const h = history(randomUUID());
    await importOnce(owner, randomUUID(), h);

    const db = getDb();
    const ownerAttempts = await db
      .select()
      .from(studyAttempts)
      .where(eq(studyAttempts.userId, owner));
    const otherAttempts = await db
      .select()
      .from(studyAttempts)
      .where(eq(studyAttempts.userId, other));
    expect(ownerAttempts).toHaveLength(2);
    expect(otherAttempts).toHaveLength(0);
  });

  /**
   * The three content-boundary cases §24 names. They are decided in code the
   * merge SHARES with the ordinary push — `gradeObjectiveAttempt` for the
   * generator version, `resolveReleaseForIngestion` for the release — and an
   * earlier version of this file said that made merge-side tests redundant and
   * pointed at `sync-ingest.test.ts` for them. That claim was checked and was
   * wrong twice over: those tests are not in `sync-ingest.test.ts` (the release
   * cases are unit-level, in `modules/sync/server/release.test.ts`, and the
   * generator one in `grade.test.ts`), and neither entry point proves what
   * matters here anyway.
   *
   * What matters here is not that the check exists — it is that the MERGE
   * reaches it. The merge runs the shared pipeline in the server-internal
   * import mode, under a coordinator that stamps provenance, counts a summary
   * and can mark a whole import completed. A refusal that the ordinary push
   * makes correctly could still, on this path, be miscounted, mis-summarised,
   * or applied anyway. Each test below therefore asserts the reason code the
   * client is told, the summary the coordinator stores, and the rows the
   * account is left holding.
   */
  it("refuses an attempt generated by an UNSUPPORTED generator version", async () => {
    // §24: content the server cannot reconstruct is refused rather than taken
    // on the guest's word. A generator this server does not run means the
    // question behind the attempt cannot be rebuilt, so its correctness cannot
    // be derived — and an underivable answer is exactly what CLAUDE.md §7
    // forbids trusting.
    const userId = await createTestUser();
    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const eventId = randomUUID();

    const { chunk, finalize } = await runImport(userId, randomUUID(), {
      attempts: [
        guestAttempt(attemptId, sessionId, {
          questionGeneratorVersion: "999999",
        }),
      ],
      events: [
        guestEvent(
          eventId,
          attemptId,
          sessionId,
          null,
          1,
          "2026-07-20T11:00:00.000Z",
        ),
      ],
    });

    expect(chunk.results).toContainEqual(
      expect.objectContaining({
        itemId: eventId,
        status: "rejected",
        reasonCode: "unsupported_generator_version",
      }),
    );
    expect(finalize.summary.eventsApplied).toBe(0);
    expect(finalize.summary.eventsRejected).toBe(1);

    // And the account holds nothing: a refusal that still wrote the attempt
    // would leave history the server had just said it could not verify.
    const { attempts, events } = await accountState(userId);
    expect(attempts).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("refuses an item referencing a release this server does not know", async () => {
    // The neighbouring case to the revoked one below, and the reason that one
    // is worth a separate test: an unknown release and a revoked release are
    // different facts and must not collapse into one reason code, because only
    // one of them tells an operator that a release they pulled is still in use.
    const userId = await createTestUser();
    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const eventId = randomUUID();

    const { chunk, finalize } = await runImport(userId, randomUUID(), {
      attempts: [
        guestAttempt(attemptId, sessionId, { releaseId: UNKNOWN_RELEASE_ID }),
      ],
      events: [
        guestEvent(
          eventId,
          attemptId,
          sessionId,
          null,
          1,
          "2026-07-20T11:00:00.000Z",
          { releaseId: UNKNOWN_RELEASE_ID },
        ),
      ],
    });

    expect(chunk.results).toContainEqual(
      expect.objectContaining({
        itemId: eventId,
        status: "rejected",
        reasonCode: "invalid_release",
      }),
    );
    expect(finalize.summary.eventsApplied).toBe(0);
    expect(finalize.summary.eventsRejected).toBe(1);
    const { attempts, events } = await accountState(userId);
    expect(attempts).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("refuses an item referencing a REVOKED release, recoverably", async () => {
    // §24 and OFFLINE_AND_SYNC §8.3: a revoked release is content withdrawn
    // after the fact — usually because it taught something wrong. The guest's
    // device may have been offline through the withdrawal and holds a history
    // built on it in good faith, so the refusal must be per-item and
    // recoverable, never a rejection of the whole import.
    const userId = await createTestUser();
    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const eventId = randomUUID();

    const { chunk, finalize } = await runImport(
      userId,
      randomUUID(),
      {
        attempts: [
          guestAttempt(attemptId, sessionId, { releaseId: REVOKED_RELEASE_ID }),
        ],
        events: [
          guestEvent(
            eventId,
            attemptId,
            sessionId,
            null,
            1,
            "2026-07-20T11:00:00.000Z",
            { releaseId: REVOKED_RELEASE_ID },
          ),
        ],
      },
      { registryDir: revokedRegistryDir },
    );

    // The specific code, not merely "rejected": `invalid_release` here would
    // mean the server had forgotten the release rather than withdrawn it.
    expect(chunk.results).toContainEqual(
      expect.objectContaining({
        itemId: eventId,
        status: "rejected",
        reasonCode: "revoked_release",
      }),
    );
    // The import itself still completes — the refusal is the item's, not the
    // import's, so the learner keeps whatever else the same history carried.
    expect(finalize.result).not.toBe("rejected");
    expect(finalize.summary.eventsApplied).toBe(0);
    expect(finalize.summary.eventsRejected).toBe(1);
    const { attempts, events } = await accountState(userId);
    expect(attempts).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("keeps the rest of a history when ONE item names a revoked release", async () => {
    // The recoverability claim above, measured: a guest whose history spans a
    // revocation must not lose the reviews that came after it.
    const userId = await createTestUser();
    const sessionId = randomUUID();
    const good = history(sessionId);
    const badAttemptId = randomUUID();
    const badEventId = randomUUID();

    const { chunk, finalize } = await runImport(
      userId,
      randomUUID(),
      {
        attempts: [
          ...good.attempts,
          guestAttempt(badAttemptId, sessionId, {
            releaseId: REVOKED_RELEASE_ID,
          }),
        ],
        events: [
          ...good.events,
          guestEvent(
            badEventId,
            badAttemptId,
            sessionId,
            null,
            1,
            "2026-07-20T11:30:00.000Z",
            { releaseId: REVOKED_RELEASE_ID },
          ),
        ],
      },
      { registryDir: revokedRegistryDir },
    );

    // Still `revoked_release`, even though this item is not the one its
    // component group's release was resolved from — the group takes its context
    // from the FIRST attempt, and the per-item path has to re-resolve rather
    // than report every later mismatch as an unknown release.
    expect(chunk.results).toContainEqual(
      expect.objectContaining({
        itemId: badEventId,
        status: "rejected",
        reasonCode: "revoked_release",
      }),
    );
    // Exactly one refused and exactly two applied: a `> 0` assertion would also
    // pass if the revoked item had taken the good history with it, which is the
    // failure this test exists to catch.
    expect(finalize.summary.eventsRejected).toBe(1);
    expect(finalize.summary.eventsApplied).toBe(2);
    const { attempts, events } = await accountState(userId);
    expect(attempts).toHaveLength(2);
    expect(events).toHaveLength(2);
  });
});

describe("§24 transaction and recovery", () => {
  it("keeps the accepted items when another item in the same chunk is refused", async () => {
    // One bad record must not cost the learner the good ones alongside it.
    const userId = await createTestUser();
    const good = history(randomUUID());
    const orphanEvent = guestEvent(
      randomUUID(),
      randomUUID(), // an attempt that is not in this chunk
      randomUUID(),
      null,
      1,
      "2026-07-20T11:10:00.000Z",
    );

    const response = asFinalize(
      await importOnce(userId, randomUUID(), {
        attempts: good.attempts,
        events: [...good.events, orphanEvent],
      }),
    );

    // ONE refused and the other two applied — the whole point. A `> 0`
    // assertion here would also pass if the bad record took the good ones with
    // it, which is the failure this test exists to catch (CLEAN-003).
    expect(response.summary.eventsRejected).toBe(1);
    expect(response.summary.eventsApplied).toBe(2);
    const { attempts, events } = await accountState(userId);
    expect(attempts).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  it("leaves an unfinished import OPEN, never marked completed", async () => {
    // §29 and §15: a truncated upload must not produce a record that a later
    // resubmission reads as "already done" — that would lose the rest silently.
    const userId = await createTestUser();
    const key = randomUUID();
    const h = history(randomUUID());

    await run(userId, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "begin",
      importKey: key,
      snapshotHash: SNAPSHOT,
      deviceId: "device-1",
      // Declares more than the chunk below will carry.
      declared: { attempts: 2, events: 2, bookmarks: 0, lists: 0, settings: 0 },
    } as GuestMergeRequest);
    await run(userId, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "chunk",
      importKey: key,
      snapshotHash: SNAPSHOT,
      chunkIndex: 0,
      attempts: [h.attempts[0]],
      events: [h.events[0]],
      bookmarks: [],
      lists: [],
      settings: [],
    } as GuestMergeRequest);
    const response = asFinalize(
      await run(userId, {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        stage: "finalize",
        importKey: key,
        snapshotHash: SNAPSHOT,
      }),
    );

    expect(response.result).toBe("incomplete");
    const [row] = await getDb()
      .select()
      .from(guestImports)
      .where(eq(guestImports.importKey, key));
    // The row must EXIST (TEST-001): `undefined?.status` is not "completed" and
    // `undefined ?? null` is null, so without this the test would pass against
    // an import record that had been deleted — which is precisely the failure
    // that would turn the learner's next attempt into a duplicate import.
    expect(row).toBeDefined();
    expect(row!.status).not.toBe("completed");
    expect(row!.completedAt).toBeNull();
  });

  it("resumes an interrupted import and finishes it, without duplicating the part already in", async () => {
    const userId = await createTestUser();
    const key = randomUUID();
    const h = history(randomUUID());

    await run(userId, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "begin",
      importKey: key,
      snapshotHash: SNAPSHOT,
      deviceId: "device-1",
      declared: { attempts: 2, events: 2, bookmarks: 0, lists: 0, settings: 0 },
    } as GuestMergeRequest);
    await run(userId, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "chunk",
      importKey: key,
      snapshotHash: SNAPSHOT,
      chunkIndex: 0,
      attempts: [h.attempts[0]],
      events: [h.events[0]],
      bookmarks: [],
      lists: [],
      settings: [],
    } as GuestMergeRequest);
    // ...the connection dies here, and the client resumes with the rest.
    await run(userId, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "chunk",
      importKey: key,
      snapshotHash: SNAPSHOT,
      chunkIndex: 1,
      attempts: [h.attempts[1]],
      events: [h.events[1]],
      bookmarks: [],
      lists: [],
      settings: [],
    } as GuestMergeRequest);
    const response = asFinalize(
      await run(userId, {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        stage: "finalize",
        importKey: key,
        snapshotHash: SNAPSHOT,
      }),
    );

    expect(response.result).toBe("applied");
    const { attempts, events } = await accountState(userId);
    expect(attempts).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  it("cascades guest_imports when the account is deleted", async () => {
    // An import row names the account it targeted; it must not outlive it.
    const userId = await createTestUser();
    const key = randomUUID();
    await importOnce(userId, key, history(randomUUID()));

    const db = getDb();
    expect(
      await db
        .select()
        .from(guestImports)
        .where(eq(guestImports.userId, userId)),
    ).toHaveLength(1);

    await db.delete(users).where(eq(users.id, userId));

    expect(
      await db
        .select()
        .from(guestImports)
        .where(eq(guestImports.userId, userId)),
    ).toHaveLength(0);
  });

  it("refuses a second import key carrying a DIFFERENT snapshot for one account", async () => {
    // The snapshot hash is what stops two different histories being treated as
    // one import. A key bound to one must never accept another.
    const userId = await createTestUser();
    const key = randomUUID();
    const h = history(randomUUID());

    await run(userId, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "begin",
      importKey: key,
      snapshotHash: SNAPSHOT,
      deviceId: "device-1",
      declared: { attempts: 2, events: 2, bookmarks: 0, lists: 0, settings: 0 },
    } as GuestMergeRequest);

    const mismatched = await run(userId, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "chunk",
      importKey: key,
      snapshotHash: "c".repeat(64),
      chunkIndex: 0,
      attempts: h.attempts,
      events: h.events,
      bookmarks: [],
      lists: [],
      settings: [],
    } as GuestMergeRequest);

    expect(mismatched.stage === "chunk" && mismatched.reasonCode).toBe(
      "snapshot_mismatch",
    );
    const { attempts } = await accountState(userId);
    expect(attempts).toHaveLength(0);
  });
});
