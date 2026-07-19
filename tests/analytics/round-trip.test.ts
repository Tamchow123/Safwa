/**
 * Real-write → real-read round trip (Phase 12 full-phase review TEST-P104):
 * the production grading write path (recordGradedAttempt) and the
 * production analytics read path (readAnalyticsSnapshot) are chained
 * against one fake-indexeddb database, pinning the stored-row shape both
 * sides must agree on — a fast, precise net for a seam otherwise proven
 * only by browser-level E2E.
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAnalyticsSnapshot } from "@/modules/analytics/persistence";
import { SafwaDb } from "@/modules/content/db";
import type { AttemptRecord } from "@/modules/study-engine/attempts";
import { recordGradedAttempt } from "@/modules/study-session/persistence";

import { makeAttempt } from "../scheduler/fixtures";

const COMPONENT =
  "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english";

function gradedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return makeAttempt({
    studyComponentId: COMPONENT,
    entryId: 1,
    skillTypeId: "meaning_recognition",
    sourceField: "madi",
    direction: "arabic_to_english",
    promptField: "madi",
    promptRef: { entryId: 1, field: "madi" },
    selectedAnswerRef: { entryId: 1, field: "meaning" },
    correctAnswerRef: { entryId: 1, field: "meaning" },
    mode: "mc",
    ...overrides,
  });
}

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-analytics-round-trip-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
});

describe("recordGradedAttempt → readAnalyticsSnapshot", () => {
  it("a really-recorded attempt appears in the derived daily activity", async () => {
    const attempt = gradedAttempt({ id: "rt-1", isCorrect: true });
    await recordGradedAttempt(db, attempt, {
      eventId: "rt-event-1",
      now: 1_784_000_000_000,
    });

    const snapshot = await readAnalyticsSnapshot(db, 1_784_000_000_500);
    // The attempt's IMMUTABLE stored local date keys the activity row, and
    // the first scheduling event counts as the day's one new item.
    expect(snapshot.dailyActivity).toEqual([
      {
        localDate: attempt.localDateAtEvent,
        attempts: 1,
        reviews: 0,
        newItems: 1,
        studyMs: attempt.responseTimeMs,
      },
    ]);
    // The component's stored scheduling state survives the read slice.
    expect(snapshot.components).toHaveLength(1);
    expect(snapshot.components[0].componentKey).toBe(COMPONENT);
    expect(snapshot.components[0].fsrs?.dueAtMs).toBeGreaterThan(0);
  });
});
