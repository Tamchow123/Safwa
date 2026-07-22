import { describe, expect, it } from "vitest";

import {
  isRecoverableReason,
  SYNC_BOUNDS,
  SYNC_PROTOCOL_VERSION,
} from "./constants";
import {
  pullQuerySchema,
  pushRequestSchema,
  syncItemResultSchema,
  totalPushItemCount,
  wireAttemptSchema,
  wireEventSchema,
  wireListSchema,
} from "./wire";

const UUID_A = "0192f9a0-1111-7abc-8def-0123456789ab";
const UUID_B = "0192f9a0-2222-7abc-8def-0123456789ab";
const UUID_C = "0192f9a0-3333-7abc-8def-0123456789ab";

function validAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID_A,
    sessionId: UUID_B,
    deviceId: "device-1",
    studyComponentId:
      "entry:5:skill:meaning_recognition:field:madi:direction:arabic_to_english",
    entryId: 5,
    skillTypeId: "meaning_recognition",
    sourceField: "madi",
    direction: "arabic_to_english",
    promptField: "madi",
    promptRef: { entryId: 5, field: "madi" },
    selectedAnswerRef: { entryId: 5, field: "meaning" },
    correctAnswerRef: { entryId: 5, field: "meaning" },
    isCorrect: true,
    isFirstAttempt: true,
    isReinforcement: false,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 4200,
    questionPosition: 0,
    mode: "mc",
    optionCount: 4,
    perQuestionLimitMs: null,
    questionInstanceId: "abc123",
    questionSeed: "seed-1",
    questionGeneratorVersion: "1",
    releaseId: "safwa-2.2.0-2b053aa72340a9d3",
    contentVersion: "2.2.0",
    occurredAtUtc: "2026-07-22T13:00:00.000Z",
    timezoneAtEvent: "Europe/London",
    utcOffsetMinutesAtEvent: 60,
    localDateAtEvent: "2026-07-22",
    timezoneSource: "browser_detected",
    ...overrides,
  };
}

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: UUID_C,
    studyComponentId:
      "entry:5:skill:meaning_recognition:field:madi:direction:arabic_to_english",
    attemptId: UUID_A,
    rating: "good",
    status: "scheduling",
    baseServerRevision: 0,
    parentEventId: null,
    clientComponentRevision: 1,
    clientSequence: 1,
    occurredAtClient: "2026-07-22T13:00:00.000Z",
    deviceId: "device-1",
    sessionId: UUID_B,
    releaseId: "safwa-2.2.0-2b053aa72340a9d3",
    contentVersion: "2.2.0",
    timezoneAtEvent: "Europe/London",
    utcOffsetMinutesAtEvent: 60,
    localDateAtEvent: "2026-07-22",
    timezoneSource: "browser_detected",
    ...overrides,
  };
}

describe("wireAttemptSchema", () => {
  it("accepts a well-formed attempt", () => {
    expect(wireAttemptSchema.parse(validAttempt())).toMatchObject({
      id: UUID_A,
    });
  });

  it("defaults an omitted optionCount to null", () => {
    const { optionCount: _omit, ...rest } = validAttempt();
    void _omit;
    expect(wireAttemptSchema.parse(rest).optionCount).toBeNull();
  });

  it("rejects unknown fields (strictObject)", () => {
    expect(wireAttemptSchema.safeParse(validAttempt({ evil: 1 })).success).toBe(
      false,
    );
  });

  it("rejects a malformed uuid id", () => {
    expect(
      wireAttemptSchema.safeParse(validAttempt({ id: "not-a-uuid" })).success,
    ).toBe(false);
  });

  it("rejects an out-of-range option count", () => {
    expect(
      wireAttemptSchema.safeParse(validAttempt({ optionCount: 9 })).success,
    ).toBe(false);
  });

  it("rejects an unknown skill type", () => {
    expect(
      wireAttemptSchema.safeParse(validAttempt({ skillTypeId: "made_up" }))
        .success,
    ).toBe(false);
  });

  it("rejects a malformed ISO instant", () => {
    expect(
      wireAttemptSchema.safeParse(
        validAttempt({ occurredAtUtc: "2026-07-22 13:00" }),
      ).success,
    ).toBe(false);
  });
});

describe("wireEventSchema", () => {
  it("accepts a well-formed scheduling event with a null parent", () => {
    expect(wireEventSchema.parse(validEvent())).toMatchObject({
      eventId: UUID_C,
    });
  });

  it("accepts a non-null parent event id", () => {
    expect(
      wireEventSchema.parse(validEvent({ parentEventId: UUID_A }))
        .parentEventId,
    ).toBe(UUID_A);
  });

  it("rejects a negative base server revision", () => {
    expect(
      wireEventSchema.safeParse(validEvent({ baseServerRevision: -1 })).success,
    ).toBe(false);
  });
});

describe("wireListSchema", () => {
  it("rejects a name longer than the DB bound", () => {
    const name = "x".repeat(SYNC_BOUNDS.maxListNameLength + 1);
    expect(
      wireListSchema.safeParse({
        id: UUID_A,
        name,
        entryIds: [1, 2],
        createdAt: 1,
        updatedAt: 2,
        deleted: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a membership snapshot over the entry bound", () => {
    const entryIds = Array.from(
      { length: SYNC_BOUNDS.maxListEntries + 1 },
      (_v, i) => i + 1,
    );
    expect(
      wireListSchema.safeParse({
        id: UUID_A,
        name: "big",
        entryIds,
        createdAt: 1,
        updatedAt: 2,
        deleted: false,
      }).success,
    ).toBe(false);
  });
});

describe("pushRequestSchema", () => {
  it("defaults every item array to empty", () => {
    const parsed = pushRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      deviceId: "device-1",
    });
    expect(totalPushItemCount(parsed)).toBe(0);
  });

  it("rejects a wrong protocol version", () => {
    expect(
      pushRequestSchema.safeParse({ protocolVersion: 2, deviceId: "device-1" })
        .success,
    ).toBe(false);
  });

  it("rejects more attempts than the per-kind bound", () => {
    const attempts = Array.from({ length: SYNC_BOUNDS.maxAttempts + 1 }, () =>
      validAttempt(),
    );
    expect(
      pushRequestSchema.safeParse({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        deviceId: "device-1",
        attempts,
      }).success,
    ).toBe(false);
  });

  it("counts items across all kinds", () => {
    const parsed = pushRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      deviceId: "device-1",
      attempts: [validAttempt()],
      events: [validEvent()],
    });
    expect(totalPushItemCount(parsed)).toBe(2);
  });

  it("rejects a batch whose total exceeds maxItemsPerBatch even when each kind is within its cap", () => {
    // 500 attempts + 500 events + 1 revocation = 1001 > 1000, but each array is
    // individually within its per-kind max.
    const attempts = Array.from({ length: SYNC_BOUNDS.maxAttempts }, () =>
      validAttempt(),
    );
    const events = Array.from({ length: SYNC_BOUNDS.maxEvents }, () =>
      validEvent(),
    );
    const result = pushRequestSchema.safeParse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      deviceId: "device-1",
      attempts,
      events,
      revocations: [
        {
          revocationId: UUID_A,
          eventId: UUID_C,
          studyComponentId: "entry:5:skill:bab_identification",
          deviceId: "device-1",
          occurredAtClient: "2026-07-22T13:00:00.000Z",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a batch exactly at maxItemsPerBatch", () => {
    const attempts = Array.from({ length: SYNC_BOUNDS.maxAttempts }, () =>
      validAttempt(),
    );
    const events = Array.from(
      { length: SYNC_BOUNDS.maxItemsPerBatch - SYNC_BOUNDS.maxAttempts },
      () => validEvent(),
    );
    const parsed = pushRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      deviceId: "device-1",
      attempts,
      events,
    });
    expect(totalPushItemCount(parsed)).toBe(SYNC_BOUNDS.maxItemsPerBatch);
  });
});

describe("pullQuerySchema", () => {
  it("applies since/limit defaults", () => {
    const parsed = pullQuerySchema.parse({});
    expect(parsed.since).toBe(0);
    expect(parsed.limit).toBe(SYNC_BOUNDS.defaultPullPageSize);
  });

  it("rejects a limit above the page-size bound", () => {
    expect(
      pullQuerySchema.safeParse({ limit: SYNC_BOUNDS.maxPullPageSize + 1 })
        .success,
    ).toBe(false);
  });
});

describe("syncItemResultSchema", () => {
  it("accepts a minimal rejected result", () => {
    expect(
      syncItemResultSchema.parse({
        itemId: UUID_A,
        itemKind: "event",
        status: "rejected",
        reasonCode: "cycle_detected",
        duplicate: false,
        recoverable: false,
      }).status,
    ).toBe("rejected");
  });

  it("rejects an unknown reason code", () => {
    expect(
      syncItemResultSchema.safeParse({
        itemId: UUID_A,
        itemKind: "event",
        status: "rejected",
        reasonCode: "made_up_reason",
        duplicate: false,
        recoverable: false,
      }).success,
    ).toBe(false);
  });
});

describe("isRecoverableReason", () => {
  it("classifies pending_parent as recoverable", () => {
    expect(isRecoverableReason("pending_parent")).toBe(true);
  });

  it("classifies cycle_detected as non-recoverable", () => {
    expect(isRecoverableReason("cycle_detected")).toBe(false);
  });
});
