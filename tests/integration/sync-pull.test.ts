import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import { loadVerifiedReleaseCached } from "@/modules/content/server-release-registry";
import {
  buildComponentKey,
  resolveComponentIdentity,
  type ResolvedComponentIdentity,
} from "@/modules/study-engine";
import {
  createQuestionContextFromRelease,
  generateQuestion,
  type QuestionContext,
  type QuestionInstance,
} from "@/modules/study-engine/generator";
import { syncCollectionsBatch } from "@/modules/sync/server/collections";
import { ingestSchedulingBatch } from "@/modules/sync/server/ingest";
import { pullChanges } from "@/modules/sync/server/pull";
import { revokeEventsBatch } from "@/modules/sync/server/revoke";
import {
  SYNCABLE_SETTING_KEYS,
  syncSettingsBatch,
} from "@/modules/sync/server/settings";
import type { WireAttempt, WireEvent } from "@/modules/sync/protocol";
import { createTestUser } from "@/tests/integration/helpers/users";

const SEED = "pull-test-seed";
const NOW = Date.parse("2026-07-20T10:01:00.000Z");
const OCCURRED = "2026-07-20T10:00:00.000Z";

let releaseId: string;
let context: QuestionContext;
let identity: ResolvedComponentIdentity;
let instance: QuestionInstance;
let entryA: number;

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
      // next entry
    }
  }
  if (!identity) throw new Error("need a generatable component");
  entryA = context.entries.map((e) => e.id).sort((a, b) => a - b)[0]!;
});

function attempt(): WireAttempt {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    deviceId: "device-1",
    studyComponentId: buildComponentKey(identity),
    entryId: identity.entryId,
    skillTypeId: "meaning_recognition",
    sourceField: "madi",
    direction: "arabic_to_english",
    promptField: instance.promptField,
    promptRef: instance.promptRef,
    selectedAnswerRef: instance.correctAnswerRef,
    correctAnswerRef: instance.correctAnswerRef,
    isCorrect: true,
    isFirstAttempt: true,
    isReinforcement: false,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 3000,
    questionPosition: 0,
    mode: "mc",
    optionCount: instance.optionCount,
    perQuestionLimitMs: null,
    questionInstanceId: instance.questionInstanceId,
    questionSeed: SEED,
    questionGeneratorVersion: "1",
    releaseId,
    contentVersion: context.contentVersion,
    occurredAtUtc: OCCURRED,
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
  };
}

function event(att: WireAttempt): WireEvent {
  return {
    eventId: randomUUID(),
    studyComponentId: att.studyComponentId,
    attemptId: att.id,
    rating: "good",
    status: "scheduling",
    baseServerRevision: 0,
    parentEventId: null,
    clientComponentRevision: 1,
    clientSequence: 1,
    occurredAtClient: OCCURRED,
    deviceId: "device-1",
    sessionId: att.sessionId,
    releaseId,
    contentVersion: context.contentVersion,
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
  };
}

describe("pullChanges", () => {
  it("bootstrap (since=0) returns every synced kind with authoritative state", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att);
    await ingestSchedulingBatch(userId, [ev], [att], { nowMs: NOW });
    await syncCollectionsBatch(
      userId,
      [{ entryId: entryA, createdAt: NOW, deleted: false }],
      [],
    );
    await syncSettingsBatch(userId, [
      { key: "theme", value: "dark", updatedAt: NOW },
    ]);

    const page = await pullChanges(
      userId,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    expect(page.hasMore).toBe(false);
    expect(page.serverCursor).toBeGreaterThan(0);

    // Component with a reconstructed card + effective learner state.
    expect(page.components).toHaveLength(1);
    expect(page.components[0]?.componentKey).toBe(buildComponentKey(identity));
    expect(page.components[0]?.revision).toBe(1);
    expect(page.components[0]?.card).not.toBeNull();
    expect(page.components[0]?.card?.reps).toBe(1);

    // Event status, bookmark, and settings all surfaced.
    expect(
      page.events.some(
        (e) => e.eventId === ev.eventId && e.status === "scheduling",
      ),
    ).toBe(true);
    expect(page.bookmarks.some((b) => b.entryId === entryA)).toBe(true);
    expect(
      page.settings.some((s) => s.key === "theme" && s.value === "dark"),
    ).toBe(true);
  });

  it("incremental pull since a cursor returns only newer changes", async () => {
    const userId = await createTestUser();
    const first = await syncCollectionsBatch(
      userId,
      [{ entryId: entryA, createdAt: NOW, deleted: false }],
      [],
    );
    const cursorAfterFirst = first.serverCursor;

    await syncSettingsBatch(userId, [
      { key: "optionCount", value: 6, updatedAt: NOW },
    ]);

    const page = await pullChanges(
      userId,
      { since: cursorAfterFirst, limit: 100 },
      { nowMs: NOW },
    );
    // Only the settings change is newer than the bookmark's cursor.
    expect(page.bookmarks).toHaveLength(0);
    expect(
      page.settings.some((s) => s.key === "optionCount" && s.value === 6),
    ).toBe(true);
    expect(page.serverCursor).toBeGreaterThan(cursorAfterFirst);
  });

  it("scopes strictly to the account — never returns another user's data", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    await syncCollectionsBatch(
      owner,
      [{ entryId: entryA, createdAt: NOW, deleted: false }],
      [],
    );

    const page = await pullChanges(
      other,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    expect(page.bookmarks).toHaveLength(0);
    expect(page.components).toHaveLength(0);
    expect(page.serverCursor).toBe(0);
  });

  it("surfaces a deletion as a tombstone", async () => {
    const userId = await createTestUser();
    await syncCollectionsBatch(
      userId,
      [{ entryId: entryA, createdAt: NOW, deleted: false }],
      [],
    );
    await syncCollectionsBatch(
      userId,
      [{ entryId: entryA, createdAt: NOW, deleted: true }],
      [],
    );

    const page = await pullChanges(
      userId,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    expect(
      page.tombstones.some(
        (t) => t.kind === "bookmark" && t.ref === String(entryA),
      ),
    ).toBe(true);
    expect(page.bookmarks).toHaveLength(0); // deleted row gone
  });

  it("reflects a revocation as an event-status update + reset component", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att);
    await ingestSchedulingBatch(userId, [ev], [att], { nowMs: NOW });
    await revokeEventsBatch(
      userId,
      [
        {
          revocationId: randomUUID(),
          eventId: ev.eventId,
          studyComponentId: ev.studyComponentId,
          deviceId: "device-1",
          occurredAtClient: OCCURRED,
        },
      ],
      { nowMs: NOW },
    );

    const page = await pullChanges(
      userId,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    expect(
      page.events.some(
        (e) => e.eventId === ev.eventId && e.status === "revoked",
      ),
    ).toBe(true);
    // The component was replayed without the revoked event → reset to new.
    expect(page.components[0]?.card).toBeNull();
    expect(page.components[0]?.learnerState).toBe("not_started");
  });

  it("surfaces exactly the SYNCABLE_SETTING_KEYS on pull (single-source guard)", async () => {
    const userId = await createTestUser();
    await syncSettingsBatch(userId, [
      { key: "theme", value: "dark", updatedAt: NOW },
      { key: "arabicFontScale", value: "large", updatedAt: NOW },
      {
        key: "timezone",
        value: { mode: "iana", name: "Asia/Dubai" },
        updatedAt: NOW,
      },
      { key: "questionCount", value: 25, updatedAt: NOW },
      { key: "optionCount", value: 5, updatedAt: NOW },
      { key: "dailyNewTarget", value: 15, updatedAt: NOW },
      { key: "dailyReviewTarget", value: 30, updatedAt: NOW },
    ]);
    const page = await pullChanges(
      userId,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    // If a syncable key is added on the write side but not surfaced by pull (or
    // vice versa), this fails — the two sides share one source of truth.
    expect(page.settings.map((s) => s.key).sort()).toEqual(
      [...SYNCABLE_SETTING_KEYS].sort(),
    );
    const timezone = page.settings.find((s) => s.key === "timezone");
    expect(timezone?.value).toEqual({ mode: "iana", name: "Asia/Dubai" });
  });

  it("uses the partial pull-cursor index for the components since-query (REL-003-T3)", async () => {
    const userId = await createTestUser();
    const att = attempt();
    await ingestSchedulingBatch(userId, [event(att)], [att], { nowMs: NOW });

    // With seqscan disabled, the planner must fall back to the ONLY viable
    // access path for `user_id = X AND last_sync_seq > since` — the partial
    // index study_components_sync_idx. If the index didn't serve this query the
    // plan would still be a (disabled-cost) seqscan; asserting the index name
    // appears proves the pull query pattern is index-served (§30, D1).
    const db = getDb();
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute<{ ["QUERY PLAN"]: string }>(
        sql`explain select id from study_components where user_id = ${userId} and last_sync_seq > 0 order by last_sync_seq`,
      );
      return (rows as unknown as { rows: Record<string, string>[] }).rows
        .map((r) => r["QUERY PLAN"])
        .join("\n");
    });
    expect(plan).toContain("study_components_sync_idx");
  });

  it("paginates gap-free: hasMore advances and the union of pages covers every change", async () => {
    const userId = await createTestUser();
    // Five DIFFERENT bookmarks in five separate pushes → five distinct rows,
    // each stamped with its own cursor value (settings would overwrite one row).
    const entryIds = context.entries
      .map((e) => e.id)
      .sort((a, b) => a - b)
      .slice(0, 5);
    expect(entryIds).toHaveLength(5);
    for (const entryId of entryIds) {
      await syncCollectionsBatch(
        userId,
        [{ entryId, createdAt: NOW, deleted: false }],
        [],
      );
    }
    // limit=1 forces one cursor-group per page.
    let since = 0;
    let pages = 0;
    const seenEntries = new Set<number>();
    for (;;) {
      const page = await pullChanges(
        userId,
        { since, limit: 1 },
        { nowMs: NOW },
      );
      pages++;
      // Each non-final page must strictly advance the cursor (no infinite loop).
      expect(page.serverCursor).toBeGreaterThan(since);
      for (const bookmark of page.bookmarks) seenEntries.add(bookmark.entryId);
      since = page.serverCursor;
      if (!page.hasMore) break;
      if (pages > 20) throw new Error("pagination did not terminate");
    }
    expect(pages).toBe(5); // one per distinct cursor value
    // Gap-free: the union of all pages covers every bookmark exactly.
    expect([...seenEntries].sort((a, b) => a - b)).toEqual(entryIds);
  });
});
