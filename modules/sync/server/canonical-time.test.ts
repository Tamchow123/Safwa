import { describe, expect, it } from "vitest";

import { computeEventTimeFields } from "@/modules/study-engine/attempts";

import {
  computeCanonicalEventTime,
  FUTURE_TOLERANCE_MS,
  type CanonicalTimeInput,
} from "./canonical-time";

const LONDON = "Europe/London";

/** The internally-consistent event-time metadata for an instant in a zone. */
function truth(epochMs: number, timezone = LONDON) {
  return computeEventTimeFields(epochMs, {
    timezone,
    timezoneSource: "browser_detected",
  });
}

function inputFor(
  clientMs: number,
  serverReceivedAtMs: number,
  overrides: Partial<CanonicalTimeInput> = {},
): CanonicalTimeInput {
  const t = truth(clientMs);
  return {
    occurredAtClient: new Date(clientMs).toISOString(),
    timezoneAtEvent: t.timezoneAtEvent,
    utcOffsetMinutesAtEvent: t.utcOffsetMinutesAtEvent,
    localDateAtEvent: t.localDateAtEvent,
    timezoneSource: "browser_detected",
    serverReceivedAtMs,
    previousAcceptedCanonicalMs: null,
    ...overrides,
  };
}

const CLIENT = Date.parse("2026-07-22T13:00:00.000Z");
const RECEIVED = Date.parse("2026-07-22T13:00:05.000Z");

describe("computeCanonicalEventTime", () => {
  it("accepts valid metadata unchanged and preserves the submitted local date", () => {
    const r = computeCanonicalEventTime(inputFor(CLIENT, RECEIVED));
    expect(r.clockSuspect).toBe(false);
    expect(r.timezoneCorrected).toBe(false);
    expect(r.occurredAtCanonicalMs).toBe(CLIENT);
    expect(r.localDateAtEvent).toBe("2026-07-22");
    expect(r.timezoneSource).toBe("browser_detected");
  });

  it("accepts a correct post-DST-transition instant without correction", () => {
    // London leaves BST 2026-10-25 01:00 UTC (offset +60 -> 0). This instant is
    // after the transition, so the correct offset is 0.
    const postDst = Date.parse("2026-10-25T02:30:00.000Z");
    const r = computeCanonicalEventTime(inputFor(postDst, postDst + 3000));
    expect(r.timezoneCorrected).toBe(false);
    expect(r.utcOffsetMinutesAtEvent).toBe(
      truth(postDst).utcOffsetMinutesAtEvent,
    );
  });

  it("accepts a future timestamp within tolerance verbatim", () => {
    const client = RECEIVED + (FUTURE_TOLERANCE_MS - 1000);
    const r = computeCanonicalEventTime(inputFor(client, RECEIVED));
    expect(r.clockSuspect).toBe(false);
    expect(r.occurredAtCanonicalMs).toBe(client);
  });

  it("clamps a future timestamp beyond tolerance to server receipt and flags it", () => {
    const client = RECEIVED + FUTURE_TOLERANCE_MS + 60_000;
    const r = computeCanonicalEventTime(inputFor(client, RECEIVED));
    expect(r.clockSuspect).toBe(true);
    expect(r.occurredAtCanonicalMs).toBe(RECEIVED);
  });

  it("flags an impossible (inconsistent) UTC offset", () => {
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED, {
        utcOffsetMinutesAtEvent: truth(CLIENT).utcOffsetMinutesAtEvent + 30,
      }),
    );
    expect(r.timezoneCorrected).toBe(true);
  });

  it("falls back to UTC/server_fallback for an unknown timezone", () => {
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED, { timezoneAtEvent: "Mars/Phobos" }),
    );
    expect(r.timezoneCorrected).toBe(true);
    expect(r.timezoneSource).toBe("server_fallback");
    expect(r.timezoneAtEvent).toBe("UTC");
    // The instant itself is still preserved.
    expect(r.occurredAtCanonicalMs).toBe(CLIENT);
  });

  it("clamps a backwards device clock up to the previous accepted event", () => {
    const previousAcceptedCanonicalMs = CLIENT + 10 * 60_000;
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED + 20 * 60_000, {
        previousAcceptedCanonicalMs,
      }),
    );
    expect(r.clockSuspect).toBe(true);
    expect(r.occurredAtCanonicalMs).toBe(previousAcceptedCanonicalMs);
  });

  it("flags a malformed / mismatched local date", () => {
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED, { localDateAtEvent: "2020-01-01" }),
    );
    expect(r.timezoneCorrected).toBe(true);
  });

  it("falls back to server receipt for an unparseable client instant", () => {
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED, { occurredAtClient: "not-a-timestamp" }),
    );
    expect(r.clockSuspect).toBe(true);
    expect(r.timezoneCorrected).toBe(true);
    expect(r.occurredAtCanonicalMs).toBe(RECEIVED);
    // Even on fallback the local date is recomputed at the canonical instant.
    expect(r.localDateAtEvent).toBe(truth(RECEIVED).localDateAtEvent);
  });

  it("does not move canonical time backwards when the event is later than prev", () => {
    const previousAcceptedCanonicalMs = CLIENT - 60_000;
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED, { previousAcceptedCanonicalMs }),
    );
    expect(r.clockSuspect).toBe(false);
    expect(r.occurredAtCanonicalMs).toBe(CLIENT);
  });

  it("caps canonical at the future ceiling when a skewed prev exceeds it (REL-001)", () => {
    // A previous-canonical poisoned by cross-instance server clock skew, well
    // past this event's own future-tolerance ceiling.
    const previousAcceptedCanonicalMs =
      RECEIVED + FUTURE_TOLERANCE_MS + 600_000;
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED, { previousAcceptedCanonicalMs }),
    );
    expect(r.clockSuspect).toBe(true);
    // Ceiling wins over the backwards-floor: never past server_received+tolerance.
    expect(r.occurredAtCanonicalMs).toBe(RECEIVED + FUTURE_TOLERANCE_MS);
  });

  it("ignores a non-finite previousAcceptedCanonicalMs (REL-002)", () => {
    const r = computeCanonicalEventTime(
      inputFor(CLIENT, RECEIVED, { previousAcceptedCanonicalMs: Number.NaN }),
    );
    expect(r.clockSuspect).toBe(false);
    expect(r.occurredAtCanonicalMs).toBe(CLIENT);
  });

  it("throws on a non-finite serverReceivedAtMs precondition (REL-002)", () => {
    expect(() =>
      computeCanonicalEventTime(
        inputFor(CLIENT, Number.NaN, { previousAcceptedCanonicalMs: null }),
      ),
    ).toThrow(/finite serverReceivedAtMs/);
  });
});
