/**
 * Pure daily-activity derivation (Phase 12 §8): honest attempt counting,
 * study-time summation, scheduling-authoritative new/review classification,
 * revoked/rejected exclusion, conflict-demotion semantics, corrupt-row
 * skipping, and agreement with the Phase 10 daily-target accounting.
 */
import { describe, expect, it } from "vitest";

import {
  deriveDailyActivity,
  isValidActivityAttempt,
} from "@/modules/analytics/activity";
import { remainingDailyTargets } from "@/modules/study-session/mixed";

import { attempt, event } from "./fixtures";

describe("isValidActivityAttempt (§8.1–8.2)", () => {
  it("accepts a full valid attempt", () => {
    expect(isValidActivityAttempt(attempt(), undefined)).toBe(true);
  });

  it("zero response time is valid (instant answers happen)", () => {
    expect(
      isValidActivityAttempt(attempt({ responseTimeMs: 0 }), undefined),
    ).toBe(true);
  });

  it("rejects structurally unusable rows", () => {
    expect(isValidActivityAttempt(attempt({ id: "" }), undefined)).toBe(false);
    expect(
      isValidActivityAttempt(attempt({ componentKey: "" }), undefined),
    ).toBe(false);
    expect(
      isValidActivityAttempt(attempt({ localDateAtEvent: null }), undefined),
    ).toBe(false);
    expect(
      isValidActivityAttempt(
        attempt({ localDateAtEvent: "not-a-date" }),
        undefined,
      ),
    ).toBe(false);
    expect(
      isValidActivityAttempt(
        attempt({ responseTimeMs: Number.NaN }),
        undefined,
      ),
    ).toBe(false);
    expect(
      isValidActivityAttempt(
        attempt({ responseTimeMs: Number.POSITIVE_INFINITY }),
        undefined,
      ),
    ).toBe(false);
    expect(
      isValidActivityAttempt(attempt({ responseTimeMs: -1 }), undefined),
    ).toBe(false);
  });

  it("a revoked or sync-rejected linked event excludes the attempt", () => {
    const a = attempt();
    expect(
      isValidActivityAttempt(a, event({ attemptId: a.id, status: "revoked" })),
    ).toBe(false);
    expect(
      isValidActivityAttempt(
        a,
        event({ attemptId: a.id, syncStatus: "rejected" }),
      ),
    ).toBe(false);
  });

  it("a conflict-demoted linked event does NOT exclude the attempt", () => {
    const a = attempt();
    expect(
      isValidActivityAttempt(
        a,
        event({ attemptId: a.id, status: "conflict_demoted" }),
      ),
    ).toBe(true);
  });
});

describe("deriveDailyActivity — attempts and study time (§8.1, §8.3–8.4)", () => {
  it("counts every valid submitted answer and sums response time", () => {
    // Correct, incorrect, hinted, reinforcement and timed-expiry rows are
    // indistinguishable here BY DESIGN: all are attempts (§8.3).
    const rows = deriveDailyActivity(
      [
        attempt({ responseTimeMs: 1000 }),
        attempt({ responseTimeMs: 2500 }),
        attempt({ responseTimeMs: 0 }),
      ],
      [],
    );
    expect(rows).toEqual([
      {
        localDate: "2026-07-17",
        attempts: 3,
        reviews: 0,
        newItems: 0,
        studyMs: 3500,
      },
    ]);
  });

  it("groups by each attempt's IMMUTABLE stored local date, sorted ascending", () => {
    const rows = deriveDailyActivity(
      [
        attempt({ localDateAtEvent: "2026-07-18" }),
        attempt({ localDateAtEvent: "2026-07-16" }),
        attempt({ localDateAtEvent: "2026-07-18" }),
      ],
      [],
    );
    expect(rows.map((row) => row.localDate)).toEqual([
      "2026-07-16",
      "2026-07-18",
    ]);
    expect(rows[1].attempts).toBe(2);
  });

  it("skips corrupt legacy rows without poisoning valid ones", () => {
    const rows = deriveDailyActivity(
      [
        attempt(),
        attempt({ localDateAtEvent: "garbage" }),
        attempt({ responseTimeMs: Number.NaN }),
        attempt({ id: "" }),
      ],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(1);
  });

  it("excludes attempts whose linked event is revoked or rejected", () => {
    const revoked = attempt();
    const rejected = attempt();
    const kept = attempt();
    const rows = deriveDailyActivity(
      [revoked, rejected, kept],
      [
        event({ attemptId: revoked.id, status: "revoked" }),
        event({ attemptId: rejected.id, syncStatus: "rejected" }),
      ],
    );
    // The two excluded attempts contribute nothing; their events also do not
    // count as scheduling (revoked status / rejected lifecycle).
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].studyMs).toBe(kept.responseTimeMs);
  });

  it("deleting an attempt (undo) removes its activity on re-derivation", () => {
    const kept = attempt();
    const undone = attempt();
    const before = deriveDailyActivity([kept, undone], []);
    expect(before[0].attempts).toBe(2);
    const after = deriveDailyActivity([kept], []);
    expect(after[0].attempts).toBe(1);
    expect(after[0].studyMs).toBe(kept.responseTimeMs);
  });

  it("no valid records → no rows (missing dates never invent activity)", () => {
    expect(deriveDailyActivity([], [])).toEqual([]);
    expect(
      deriveDailyActivity([attempt({ localDateAtEvent: null })], []),
    ).toEqual([]);
  });
});

describe("deriveDailyActivity — new items and reviews (§8.5)", () => {
  it("classifies chain roots as new items and non-roots as reviews", () => {
    const rows = deriveDailyActivity(
      [],
      [
        event({ parentEventId: null }),
        event({ parentEventId: null }),
        event({ parentEventId: "event-1" }),
      ],
    );
    expect(rows[0].newItems).toBe(2);
    expect(rows[0].reviews).toBe(1);
  });

  it("excludes every non-scheduling lifecycle and rejected sync status", () => {
    const rows = deriveDailyActivity(
      [],
      [
        event({ status: "reinforcement" }),
        event({ status: "conflict_demoted" }),
        event({ status: "revoked" }),
        event({ status: "pending_parent" }),
        event({ status: null }),
        event({ syncStatus: "rejected" }),
        event({ parentEventId: undefined }), // corrupt parent link
        event({ localDateAtEvent: null }), // unreadable date
      ],
    );
    expect(rows).toEqual([]);
  });

  it("a reinforcement-linked attempt still counts toward attempts and study time", () => {
    // §8.1/§22: reinforcement is genuine study activity. The linked event's
    // reinforcement lifecycle must not be mistaken for an exclusion marker
    // (only revoked / sync-rejected exclude), and the event itself never
    // consumes a scheduling target.
    const recovery = attempt();
    const rows = deriveDailyActivity(
      [recovery],
      [
        event({
          attemptId: recovery.id,
          status: "reinforcement",
          parentEventId: null,
        }),
      ],
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].studyMs).toBe(recovery.responseTimeMs);
    expect(rows[0].newItems).toBe(0);
    expect(rows[0].reviews).toBe(0);
  });

  it("a conflict-demoted event: attempt counts as activity, event consumes no target", () => {
    const demoted = attempt();
    const rows = deriveDailyActivity(
      [demoted],
      [
        event({
          attemptId: demoted.id,
          status: "conflict_demoted",
          parentEventId: null,
        }),
      ],
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].studyMs).toBe(demoted.responseTimeMs);
    expect(rows[0].newItems).toBe(0);
    expect(rows[0].reviews).toBe(0);
  });

  it("agrees with the Phase 10 daily-target accounting on identical events", () => {
    const TODAY = "2026-07-17";
    const events = [
      event({ parentEventId: null }),
      event({ parentEventId: null }),
      event({ parentEventId: "root-1" }),
      event({ parentEventId: "root-1", status: "reinforcement" }),
      event({ parentEventId: null, localDateAtEvent: "2026-07-16" }),
    ];
    const rows = deriveDailyActivity([], events);
    const today = rows.find((row) => row.localDate === TODAY)!;

    const remaining = remainingDailyTargets(
      events.map((record) => ({
        componentKey: "c",
        parentEventId: record.parentEventId as string | null,
        status: record.status,
        localDateAtEvent: record.localDateAtEvent,
      })),
      TODAY,
      { newLimit: 10, reviewLimit: 20 },
    );
    // Both consumers derive from the ONE shared classifier: what activity
    // counts as consumed must equal what the target accounting deducts.
    expect(remaining.newLimit).toBe(10 - today.newItems);
    expect(remaining.reviewLimit).toBe(20 - today.reviews);
  });

  it("an undone (deleted) event refunds its count on re-derivation", () => {
    const kept = event({ parentEventId: null });
    const undone = event({ parentEventId: "kept" });
    expect(deriveDailyActivity([], [kept, undone])[0].reviews).toBe(1);
    const after = deriveDailyActivity([], [kept]);
    expect(after[0].reviews).toBe(0);
    expect(after[0].newItems).toBe(1);
  });
});
