import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import type {
  PullQuery,
  PullResponse,
  PushRequest,
  PushResponse,
} from "@/modules/sync/protocol";
import type { AttemptRecord } from "@/modules/study-engine/attempts";

import type { SyncApiResult } from "./api";
import { toWireAttempt } from "./local-selection";
import {
  enqueueBookmarkMutation,
  enqueueReinforcementMutation,
  enqueueRevocationMutation,
} from "./mutation-queue";
import { isSyncRunning, runSync, type RunSyncDeps } from "./orchestrator";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-orchestrator-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

function pushOk(
  results: PushResponse["results"] = [],
): SyncApiResult<PushResponse> {
  return {
    ok: true,
    data: {
      protocolVersion: 1,
      serverCursor: 1,
      activeReleaseId: "rel-1",
      results,
    },
  };
}
function pullPage(
  hasMore: boolean,
  serverCursor: number,
): SyncApiResult<PullResponse> {
  return {
    ok: true,
    data: {
      protocolVersion: 1,
      serverCursor,
      activeReleaseId: "rel-1",
      hasMore,
      components: [],
      events: [],
      bookmarks: [],
      lists: [],
      settings: [],
      tombstones: [],
      notices: [],
    },
  };
}

function deps(over: Partial<RunSyncDeps> = {}): RunSyncDeps {
  return {
    db,
    userId: `user-${counter}`,
    deviceId: "device-1",
    now: () => 1000,
    online: () => true,
    isCurrentAccount: () => true,
    push: vi.fn(async () => pushOk()),
    pull: vi.fn(async () => pullPage(false, 1)),
    ...over,
  };
}

function makeAttempt(ownerId = "u"): AttemptRecord {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    userId: ownerId,
    deviceId: "device-1",
    studyComponentId:
      "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english",
    entryId: 1,
    skillTypeId: "meaning_recognition",
    sourceField: "madi",
    direction: "arabic_to_english",
    promptField: "madi",
    promptRef: { entryId: 1, field: "madi" },
    selectedAnswerRef: { entryId: 1, field: "meaning" },
    correctAnswerRef: { entryId: 1, field: "meaning" },
    isCorrect: true,
    isFirstAttempt: true,
    isReinforcement: false,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 3000,
    questionPosition: 0,
    mode: "mc",
    optionCount: 4,
    perQuestionLimitMs: null,
    questionInstanceId: "qi",
    questionSeed: "seed",
    questionGeneratorVersion: "1",
    releaseId: "rel-1",
    contentVersion: "v1",
    occurredAtUtc: "2026-07-20T10:00:00.000Z",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
  };
}

// The seeded event is OWNED by `ownerId` — the push selector only sends the
// active account's own rows (§18, EXT-F1), so the owner must match runSync's userId.
async function insertLocalEvent(ownerId = "u"): Promise<string> {
  const att = makeAttempt(ownerId);
  await db.studyAttempts.add({
    id: att.id,
    componentKey: att.studyComponentId,
    sessionId: att.sessionId,
    attemptedAt: 1,
    attempt: att,
  });
  const eventId = randomUUID();
  await db.reviewEvents.add({
    eventId,
    componentKey: att.studyComponentId,
    parentEventId: null,
    clientComponentRevision: 1,
    syncStatus: "local",
    createdAt: 1,
    attemptId: att.id,
    rating: "good",
    status: "scheduling",
    baseServerRevision: 0,
    clientSequence: 1,
    occurredAtClient: "2026-07-20T10:00:00.000Z",
    deviceId: "device-1",
    sessionId: att.sessionId,
    releaseId: "rel-1",
    contentVersion: "v1",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
  });
  return eventId;
}

describe("runSync", () => {
  it("returns offline without touching the network", async () => {
    const d = deps({ online: () => false, userId: "u-offline" });
    const result = await runSync(d);
    expect(result.outcome).toBe("offline");
    expect(d.push).not.toHaveBeenCalled();
    expect(d.pull).not.toHaveBeenCalled();
  });

  it("pushes local events, applies results, pulls, and returns synced", async () => {
    const eventId = await insertLocalEvent("u-full");
    const push = vi.fn(async (req: PushRequest) => {
      expect(req.events).toHaveLength(1);
      expect(req.attempts).toHaveLength(1);
      return pushOk([
        {
          itemId: eventId,
          itemKind: "event",
          status: "accepted",
          reasonCode: "accepted",
          duplicate: false,
          recoverable: false,
        },
      ]);
    });
    const result = await runSync(deps({ userId: "u-full", push }));
    expect(result.outcome).toBe("synced");
    expect(push).toHaveBeenCalledOnce();
    // The pushed event is now marked accepted locally.
    expect((await db.reviewEvents.get(eventId))?.syncStatus).toBe("accepted");
  });

  it("skips the push when there is no local work at all", async () => {
    const push = vi.fn(async () => pushOk());
    const result = await runSync(deps({ userId: "u-nopush", push }));
    expect(result.outcome).toBe("synced");
    expect(push).not.toHaveBeenCalled();
  });

  it("pushes queued mutations even with no scheduling events, and acks them (EXT-F2)", async () => {
    await enqueueBookmarkMutation(db, {
      userId: "u-mut",
      entryId: 7,
      createdAt: 1,
      deleted: false,
      now: 1,
    });
    const push = vi.fn(async (req: PushRequest) => {
      expect(req.events).toHaveLength(0);
      expect(req.bookmarks).toEqual([
        { entryId: 7, createdAt: 1, deleted: false },
      ]);
      return pushOk([
        {
          itemId: "7",
          itemKind: "bookmark",
          status: "accepted",
          reasonCode: "accepted",
          duplicate: false,
          recoverable: false,
        },
      ]);
    });
    const result = await runSync(deps({ userId: "u-mut", push }));
    expect(result.outcome).toBe("synced");
    expect(push).toHaveBeenCalledOnce();
    // Accepted → the queued mutation was removed from the outbox.
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it("merges reinforcement attempts into the attempts array (EXT-F2)", async () => {
    const attemptId = randomUUID();
    // The real mapper drops the local-only userId to produce a strict WireAttempt.
    const attempt = toWireAttempt({
      ...makeAttempt("u-reinf"),
      id: attemptId,
      isReinforcement: true,
    })!;
    await enqueueReinforcementMutation(db, {
      userId: "u-reinf",
      attempt,
      now: 1,
    });
    const push = vi.fn(async (req: PushRequest) => {
      expect(req.events).toHaveLength(0);
      expect(req.attempts).toHaveLength(1);
      expect(req.attempts[0]?.id).toBe(attemptId);
      return pushOk([
        {
          itemId: attemptId,
          itemKind: "attempt",
          status: "accepted",
          reasonCode: "accepted",
          duplicate: false,
          recoverable: false,
        },
      ]);
    });
    const result = await runSync(deps({ userId: "u-reinf", push }));
    expect(result.outcome).toBe("synced");
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it("sends scheduling AND a queued revocation together (mutations not starved, REL-001)", async () => {
    await insertLocalEvent("u-mix");
    await insertLocalEvent("u-mix");
    await enqueueRevocationMutation(db, {
      userId: "u-mix",
      revocation: {
        revocationId: randomUUID(),
        eventId: randomUUID(),
        studyComponentId:
          "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english",
        deviceId: "device-1",
        occurredAtClient: "2026-07-20T10:00:00.000Z",
      },
      now: 1,
    });
    const push = vi.fn(async (req: PushRequest) => {
      expect(req.events).toHaveLength(2); // scheduling still sent
      expect(req.revocations).toHaveLength(1); // and the revocation is NOT starved
      return pushOk();
    });
    const result = await runSync(deps({ userId: "u-mix", push }));
    expect(result.outcome).toBe("synced");
    expect(push).toHaveBeenCalledOnce();
  });

  it("does not upload another account's queued mutations (EXT-F1)", async () => {
    await enqueueBookmarkMutation(db, {
      userId: "someone-else",
      entryId: 7,
      createdAt: 1,
      deleted: false,
      now: 1,
    });
    const push = vi.fn(async () => pushOk());
    const result = await runSync(deps({ userId: "u-scoped", push }));
    expect(result.outcome).toBe("synced");
    expect(push).not.toHaveBeenCalled(); // nothing of THIS account's to send
  });

  it("pages the pull until hasMore is false", async () => {
    const pull = vi
      .fn<(q: PullQuery) => Promise<SyncApiResult<PullResponse>>>()
      .mockResolvedValueOnce(pullPage(true, 5))
      .mockResolvedValueOnce(pullPage(false, 9));
    const result = await runSync(deps({ userId: "u-page", pull }));
    expect(result.outcome).toBe("synced");
    expect(pull).toHaveBeenCalledTimes(2);
    expect(pull.mock.calls[1]?.[0]).toMatchObject({ since: 5 });
  });

  it("coalesces overlapping runs for the same account onto one run", async () => {
    // Deferred created up front so the resolver exists before the mock is called.
    let resolvePull!: (v: SyncApiResult<PullResponse>) => void;
    const pending = new Promise<SyncApiResult<PullResponse>>((r) => {
      resolvePull = r;
    });
    const pull = vi.fn(() => pending);
    const d = deps({ userId: "u-coalesce", pull });
    const a = runSync(d);
    const b = runSync(d);
    expect(a).toBe(b); // same in-flight promise — the second call coalesces
    resolvePull(pullPage(false, 1));
    await a;
    expect(pull).toHaveBeenCalledOnce();
  });

  it("stops without applying when the account changes mid-run (logout guard)", async () => {
    const eventId = await insertLocalEvent("u-logout");
    // Account is current for the push guard, then NOT current for the pull guard.
    const isCurrentAccount = vi
      .fn<(u: string) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const pull = vi.fn(async () => pullPage(false, 9));
    const result = await runSync(
      deps({
        userId: "u-logout",
        push: vi.fn(async () =>
          pushOk([
            {
              itemId: eventId,
              itemKind: "event",
              status: "accepted",
              reasonCode: "accepted",
              duplicate: false,
              recoverable: false,
            },
          ]),
        ),
        pull,
        isCurrentAccount,
      }),
    );
    expect(result.outcome).toBe("invalidated");
    // The pull ran but its result was NOT applied (guard fired) — cursor unmoved.
  });

  it("maps a network push failure to retry, not attempting the pull", async () => {
    await insertLocalEvent("u-neterr");
    const pull = vi.fn(async () => pullPage(false, 1));
    const result = await runSync(
      deps({
        userId: "u-neterr",
        push: vi.fn(async (): Promise<SyncApiResult<PushResponse>> => ({
          ok: false,
          reason: "network",
        })),
        pull,
      }),
    );
    expect(result.outcome).toBe("retry");
    expect(pull).not.toHaveBeenCalled();
  });

  it("maps a 401 to auth_lost", async () => {
    const result = await runSync(
      deps({
        userId: "u-401",
        pull: vi.fn(async (): Promise<SyncApiResult<PullResponse>> => ({
          ok: false,
          reason: "unauthorized",
          status: 401,
        })),
      }),
    );
    expect(result.outcome).toBe("auth_lost");
  });

  it("settles to retry on a hung request and frees the single-flight slot (REL-001)", async () => {
    // A pull that never resolves must not wedge the run: the timeout guarantees
    // settlement, and the in-flight slot must clear so a later run can start.
    const hangingPull = vi.fn(
      () => new Promise<SyncApiResult<PullResponse>>(() => {}),
    );
    const result = await runSync(
      deps({ userId: "u-hang", pull: hangingPull, requestTimeoutMs: 20 }),
    );
    expect(result.outcome).toBe("retry");
    expect(isSyncRunning("u-hang")).toBe(false); // slot freed
    // A subsequent run for the same account starts fresh (not the dead promise).
    const settlingPull = vi.fn(async () => pullPage(false, 1));
    const second = await runSync(
      deps({ userId: "u-hang", pull: settlingPull }),
    );
    expect(second.outcome).toBe("synced");
    expect(settlingPull).toHaveBeenCalledOnce();
  });

  it("stops with retry on a non-advancing cursor instead of looping forever (REL-002)", async () => {
    // hasMore=true forever with a repeated serverCursor is a protocol violation.
    const stuckPull = vi.fn(async () => pullPage(true, 5));
    const result = await runSync(deps({ userId: "u-stuck", pull: stuckPull }));
    expect(result.outcome).toBe("retry");
    // Bounded: page 1 advances 0→5 legitimately; page 2 repeats 5 (5 <= 5) and
    // is detected as non-advancing → retry. Two calls, not an infinite loop.
    expect(stuckPull).toHaveBeenCalledTimes(2);
  });
});
