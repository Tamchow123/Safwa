import { describe, expect, it } from "vitest";

import { computeEventTimeFields } from "@/modules/study-engine";
import {
  createReviewEvent,
  deriveLineage,
  shouldCreateEvent,
} from "@/modules/scheduler/events";

import { makeAttempt } from "./fixtures";

describe("event-creation rule (§5)", () => {
  it("creates an event only for a scheduling-relevant first attempt", () => {
    expect(
      shouldCreateEvent({ isFirstAttempt: true, isReinforcement: false }),
    ).toBe(true);
    // Reinforcement recoveries create NO event.
    expect(
      shouldCreateEvent({ isFirstAttempt: false, isReinforcement: true }),
    ).toBe(false);
    expect(
      shouldCreateEvent({ isFirstAttempt: false, isReinforcement: false }),
    ).toBe(false);
  });

  it("wrong-then-correct yields exactly one Again event + a no-event recovery", () => {
    const wrongFirst = makeAttempt({
      isFirstAttempt: true,
      isReinforcement: false,
      isCorrect: false,
    });
    const correctRecovery = makeAttempt({
      isFirstAttempt: false,
      isReinforcement: true,
      isCorrect: true,
    });

    expect(shouldCreateEvent(wrongFirst)).toBe(true);
    expect(shouldCreateEvent(correctRecovery)).toBe(false);

    const lineage = deriveLineage(null, {
      eventId: "event-1",
      clientSequence: 1,
    });
    const event = createReviewEvent(wrongFirst, lineage);
    expect(event.rating).toBe("again");
    expect(event.status).toBe("scheduling");

    // The recovery must never become an event.
    expect(() => createReviewEvent(correctRecovery, lineage)).toThrow();
  });

  it("derives sequential lineage: monotonic revisions, linked parents, base 0", () => {
    const first = deriveLineage(null, { eventId: "e1", clientSequence: 1 });
    expect(first.parentEventId).toBeNull();
    expect(first.clientComponentRevision).toBe(1);
    expect(first.baseServerRevision).toBe(0); // guest

    const e1 = createReviewEvent(makeAttempt(), first);
    const second = deriveLineage(e1, { eventId: "e2", clientSequence: 2 });
    expect(second.parentEventId).toBe("e1");
    expect(second.clientComponentRevision).toBe(2);
    expect(second.baseServerRevision).toBe(0); // inherited from the chain
  });

  it("copies the immutable event-time date fields from the attempt", () => {
    const attempt = makeAttempt({
      localDateAtEvent: "2026-03-08",
      utcOffsetMinutesAtEvent: -300,
      timezoneAtEvent: "America/New_York",
      timezoneSource: "browser_detected",
      occurredAtUtc: "2026-03-08T05:30:00.000Z",
    });
    const event = createReviewEvent(
      attempt,
      deriveLineage(null, { eventId: "e1", clientSequence: 1 }),
    );
    expect(event.localDateAtEvent).toBe("2026-03-08");
    expect(event.utcOffsetMinutesAtEvent).toBe(-300);
    expect(event.timezoneAtEvent).toBe("America/New_York");
    expect(event.timezoneSource).toBe("browser_detected");
    expect(event.occurredAtClient).toBe("2026-03-08T05:30:00.000Z");
    expect(event.attemptId).toBe(attempt.id);
  });
});

describe("event-time dates through the attempt→event path (DST / timezone)", () => {
  it("copies dates computed across a DST spring-forward (same local day)", () => {
    // 2026-03-08 US spring-forward. Two instants either side of the 02:00 jump,
    // both the SAME local calendar day in New York → one local date, but the
    // UTC offset differs (EST vs EDT).
    const before = computeEventTimeFields(Date.UTC(2026, 2, 8, 6, 0, 0), {
      timezone: "America/New_York",
      timezoneSource: "user_setting",
    });
    const after = computeEventTimeFields(Date.UTC(2026, 2, 8, 8, 0, 0), {
      timezone: "America/New_York",
      timezoneSource: "user_setting",
    });
    expect(before.localDateAtEvent).toBe("2026-03-08");
    expect(after.localDateAtEvent).toBe("2026-03-08");
    expect(before.utcOffsetMinutesAtEvent).toBe(-300); // EST
    expect(after.utcOffsetMinutesAtEvent).toBe(-240); // EDT

    const event = createReviewEvent(
      makeAttempt(before),
      deriveLineage(null, { eventId: "e1", clientSequence: 1 }),
    );
    expect(event.localDateAtEvent).toBe("2026-03-08");
    expect(event.utcOffsetMinutesAtEvent).toBe(-300);
  });

  it("a timezone change affects future events only; history is immutable", () => {
    // Same UTC instant, two different active zones (the user changed timezone
    // between reviews). Each event keeps ITS OWN computed local date — the
    // earlier event is never rewritten.
    const karachi = computeEventTimeFields(Date.UTC(2026, 6, 17, 20, 0, 0), {
      timezone: "Asia/Karachi",
      timezoneSource: "user_setting",
    });
    const nyc = computeEventTimeFields(Date.UTC(2026, 6, 17, 20, 0, 0), {
      timezone: "America/New_York",
      timezoneSource: "user_setting",
    });
    expect(karachi.localDateAtEvent).toBe("2026-07-18"); // +5 → next day
    expect(nyc.localDateAtEvent).toBe("2026-07-17"); // -4 → same day
    expect(karachi.localDateAtEvent).not.toBe(nyc.localDateAtEvent);

    const e1 = createReviewEvent(
      makeAttempt(karachi),
      deriveLineage(null, { eventId: "e1", clientSequence: 1 }),
    );
    const e2 = createReviewEvent(
      makeAttempt(nyc),
      deriveLineage(e1, { eventId: "e2", clientSequence: 2 }),
    );
    expect(e1.localDateAtEvent).toBe("2026-07-18"); // unchanged by the tz change
    expect(e2.localDateAtEvent).toBe("2026-07-17");
  });
});
