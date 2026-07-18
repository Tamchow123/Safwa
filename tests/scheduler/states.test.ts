import { describe, expect, it } from "vitest";

import { replayChain } from "@/modules/scheduler/chain";
import type { FsrsState } from "@/modules/scheduler/fsrs";
import { projectComponent } from "@/modules/scheduler/states";

import { buildChain, buildNaturalChain } from "./fixtures";

const T0 = Date.UTC(2026, 6, 17, 9, 0, 0);

/** Assign a distinct review-phase date and a distinct (never-counted) learning
 * date, so mastery-date counting can be asserted precisely. */
function distinctDates() {
  let review = 0;
  return (index: number, preState: FsrsState) => {
    if (preState === "review") {
      review += 1;
      return `2026-09-${String(review).padStart(2, "0")}`;
    }
    return `2026-08-${String(index + 1).padStart(2, "0")}`;
  };
}

describe("learner state — basics", () => {
  it("not_started with no events", () => {
    expect(projectComponent([], T0).state).toBe("not_started");
  });

  it("learning after one clean success", () => {
    const events = buildChain([{ isCorrect: true }]);
    const p = projectComponent(events, T0);
    expect(p.state).toBe("learning");
    expect(p.masteryDayCount).toBe(0); // initial learning is not a mastery day
  });

  it("not_started when the only event is a wrong answer (no clean success)", () => {
    // An Again-only component has a scheduling event but no clean success — the
    // Learning transition requires ≥1 clean success (§5).
    const events = buildChain([{ isCorrect: false }]);
    expect(projectComponent(events, T0).state).toBe("not_started");
  });
});

describe("mastery days (PRODUCT_REQUIREMENTS §5)", () => {
  it("excludes the initial learning reviews; only in-Review Good/Easy count", () => {
    const { events, preStates } = buildNaturalChain(
      ["good", "good", "good", "good", "good", "good"],
      T0,
      distinctDates(),
    );
    const { masteryDates } = replayChain(events);
    // Learning-phase dates (2026-08-*) never appear; only review-phase (09-*).
    expect(masteryDates.every((d) => d.startsWith("2026-09-"))).toBe(true);
    // The count equals the number of review-phase reviews.
    const reviewPhase = preStates.filter((s) => s === "review").length;
    expect(reviewPhase).toBeGreaterThanOrEqual(1);
    expect(masteryDates).toHaveLength(reviewPhase);
  });

  it("three Good reviews on ONE local date count as ONE mastery day", () => {
    const { events, preStates } = buildNaturalChain(
      ["good", "good", "good", "good", "good"],
      T0,
      (_i, preState) =>
        preState === "review" ? "2026-09-01" : `2026-08-0${_i + 1}`,
    );
    const reviewPhase = preStates.filter((s) => s === "review").length;
    expect(reviewPhase).toBeGreaterThanOrEqual(2); // multiple same-date reviews
    const { masteryDates } = replayChain(events);
    expect(masteryDates).toEqual(["2026-09-01"]); // deduped to one day
  });

  it("counts by stored local_date_at_event across DST / near-midnight", () => {
    // The scheduler dedups mastery days by the immutable `local_date_at_event`
    // string (Phase 6 computes it correctly across DST/near-midnight). Same
    // local date ⇒ ONE mastery day even if UTC instants straddle a DST change.
    const sameDay = buildNaturalChain(
      ["good", "good", "good", "good"],
      T0,
      (i, preState) =>
        preState === "review" ? "2026-03-08" : `2026-02-0${i + 1}`,
    );
    expect(replayChain(sameDay.events).masteryDates).toEqual(["2026-03-08"]);

    // Different local dates (near-midnight boundary) ⇒ TWO mastery days.
    let rc = 0;
    const diffDays = buildNaturalChain(
      ["good", "good", "good", "good"],
      T0,
      (i, preState) => {
        if (preState !== "review") return `2026-02-0${i + 1}`;
        rc += 1;
        return rc === 1 ? "2026-03-08" : "2026-03-09";
      },
    );
    const md = replayChain(diffDays.events).masteryDates;
    expect(md).toContain("2026-03-08");
    expect(md).toContain("2026-03-09");
  });

  it("an Easy review (in Review + due) advances a mastery day", () => {
    // The app never PRODUCES Easy, but replay must count an Easy the same as a
    // Good. Reach Review with goods, then apply a directly-constructed Easy
    // event at the card's due instant.
    const { events, finalCard } = buildNaturalChain(
      ["good", "good", "good", "good", "good"],
      T0,
      distinctDates(),
    );
    expect(finalCard.state).toBe("review");
    const head = events[events.length - 1];
    const easyEvent = {
      ...head,
      eventId: "easy-ev",
      attemptId: "easy-attempt",
      parentEventId: head.eventId,
      clientComponentRevision: head.clientComponentRevision + 1,
      clientSequence: head.clientSequence + 1,
      rating: "easy" as const,
      occurredAtClient: new Date(finalCard.dueAtMs).toISOString(),
      localDateAtEvent: "2026-12-25",
    };
    expect(replayChain([...events, easyEvent]).masteryDates).toContain(
      "2026-12-25",
    );
  });

  it("Hard never advances a mastery day", () => {
    // Reach review with goods, then a Hard (review phase) on its own date,
    // then a Good on a later date. Only the Good date is a mastery day.
    const { events } = buildNaturalChain(
      ["good", "good", "good", "hard", "good"],
      T0,
      (_i, preState) => {
        if (preState !== "review") return `2026-08-0${_i + 1}`;
        return _i === 3
          ? "HARD_DATE"
          : `2026-09-${String(_i).padStart(2, "0")}`;
      },
    );
    const { masteryDates } = replayChain(events);
    expect(masteryDates).not.toContain("HARD_DATE");
  });
});

describe("learner state — mastered ↔ needs_review", () => {
  it("mastered after ≥3 distinct mastery dates when not due; needs_review when due", () => {
    const { events, preStates } = buildNaturalChain(
      ["good", "good", "good", "good", "good", "good", "good", "good"],
      T0,
      distinctDates(),
    );
    const reviewPhase = preStates.filter((s) => s === "review").length;
    expect(reviewPhase).toBeGreaterThanOrEqual(3);

    const replay = replayChain(events);
    expect(replay.masteryDates.length).toBeGreaterThanOrEqual(3);
    const dueAt = replay.card!.dueAtMs;

    // Before due ⇒ mastered.
    expect(projectComponent(events, dueAt - 1).state).toBe("mastered");
    // At/after due ⇒ needs_review (mastery achieved but now due).
    expect(projectComponent(events, dueAt).state).toBe("needs_review");
  });

  it("a lapse after mastery projects as needs_review (even before due)", () => {
    // Reach mastery, then a wrong answer lapses the card to Relearning — that is
    // "lapsed after mastery" ⇒ needs_review even though the relearning due is in
    // the near future (not yet due).
    const { events, preStates } = buildNaturalChain(
      ["good", "good", "good", "good", "good", "good", "good", "good", "again"],
      T0,
      distinctDates(),
    );
    expect(
      preStates.filter((s) => s === "review").length,
    ).toBeGreaterThanOrEqual(3);
    const replay = replayChain(events);
    expect(replay.masteryDates.length).toBeGreaterThanOrEqual(3);
    expect(replay.card!.state).toBe("relearning");
    // Before the relearning due ⇒ still needs_review (lapsed), never mastered.
    expect(projectComponent(events, replay.card!.dueAtMs - 1).state).toBe(
      "needs_review",
    );
  });

  it("an ahead-of-schedule (not-due) Review review does not advance mastery", () => {
    const { events } = buildNaturalChain(
      ["good", "good", "good", "good"],
      T0,
      distinctDates(),
    );
    // Make the LAST review early (before the card was due) on its own date.
    const preLast = replayChain(events.slice(0, -1));
    expect(preLast.card!.state).toBe("review");
    const earlyMs = preLast.card!.dueAtMs - 1000; // strictly before due
    const early = [
      ...events.slice(0, -1),
      {
        ...events[events.length - 1],
        occurredAtClient: new Date(earlyMs).toISOString(),
        localDateAtEvent: "EARLY_DATE",
      },
    ];
    // The early review is in Review state but NOT due — it must not count.
    expect(replayChain(early).masteryDates).not.toContain("EARLY_DATE");
  });

  it("stays learning with fewer than 3 distinct mastery dates", () => {
    // Two review-phase goods on two distinct dates → only 2 mastery days.
    const { events, preStates } = buildNaturalChain(
      ["good", "good", "good"],
      T0,
      distinctDates(),
    );
    const reviewPhase = preStates.filter((s) => s === "review").length;
    if (reviewPhase < 3) {
      const replay = replayChain(events);
      expect(replay.masteryDates.length).toBeLessThan(3);
      expect(projectComponent(events, replay.card!.dueAtMs - 1).state).toBe(
        "learning",
      );
    }
  });
});
