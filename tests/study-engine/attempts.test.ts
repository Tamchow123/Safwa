import { describe, expect, it } from "vitest";

import {
  computeEventTimeFields,
  createAttemptRecord,
  type AttemptClock,
} from "@/modules/study-engine/attempts";
import { generateQuestion } from "@/modules/study-engine/generator";

import { questionContext } from "./fixtures";

function mcInstance() {
  return generateQuestion(questionContext, {
    identity: { entryId: 1, skillType: "bab_identification" },
    deliveryMode: "mc",
    questionSeed: "att",
    position: 3,
  });
}

function timedInstance() {
  return generateQuestion(questionContext, {
    identity: { entryId: 1, skillType: "bab_identification" },
    deliveryMode: "timed",
    questionSeed: "att",
    position: 3,
  });
}

describe("event-time fields", () => {
  it("computes local date and offset for a positive-offset zone", () => {
    const epoch = Date.UTC(2026, 6, 17, 9, 30, 0); // 2026-07-17T09:30:00Z
    const fields = computeEventTimeFields(epoch, {
      timezone: "Asia/Karachi",
      timezoneSource: "user_setting",
    });
    expect(fields.utcOffsetMinutesAtEvent).toBe(300); // UTC+5
    expect(fields.localDateAtEvent).toBe("2026-07-17");
    expect(fields.timezoneAtEvent).toBe("Asia/Karachi");
    expect(fields.occurredAtUtc).toBe("2026-07-17T09:30:00.000Z");
  });

  it("rolls the local date back across a UTC-midnight boundary", () => {
    const epoch = Date.UTC(2026, 6, 17, 2, 30, 0); // 02:30Z
    const fields = computeEventTimeFields(epoch, {
      timezone: "America/New_York",
      timezoneSource: "browser_detected",
    });
    // 02:30Z is 22:30 the PREVIOUS day in EDT (UTC-4).
    expect(fields.utcOffsetMinutesAtEvent).toBe(-240);
    expect(fields.localDateAtEvent).toBe("2026-07-16");
  });

  it("reflects DST: the same zone has a different offset in winter", () => {
    const summer = computeEventTimeFields(Date.UTC(2026, 6, 17, 12, 0, 0), {
      timezone: "America/New_York",
      timezoneSource: "user_setting",
    });
    const winter = computeEventTimeFields(Date.UTC(2026, 0, 15, 12, 0, 0), {
      timezone: "America/New_York",
      timezoneSource: "user_setting",
    });
    expect(summer.utcOffsetMinutesAtEvent).toBe(-240); // EDT
    expect(winter.utcOffsetMinutesAtEvent).toBe(-300); // EST
  });
});

describe("attempt records", () => {
  const clock: AttemptClock = {
    now: () => Date.UTC(2026, 6, 17, 9, 30, 0),
    timezone: "Asia/Karachi",
    timezoneSource: "user_setting",
  };

  it("captures every DATA_MODEL §5 field from the instance and clock", () => {
    const instance = mcInstance();
    const selected = instance.options.find((o) => o.isCorrect)!.ref;
    const attempt = createAttemptRecord(
      {
        id: "attempt-1",
        sessionId: "session-1",
        userId: null,
        deviceId: "device-1",
        instance,
        selectedAnswerRef: selected,
        isCorrect: true,
        isFirstAttempt: true,
        isReinforcement: false,
        hint: { used: true, type: "bab" },
        responseTimeMs: 1234,
        perQuestionLimitMs: null,
      },
      clock,
    );

    expect(attempt.userId).toBeNull();
    expect(attempt.deviceId).toBe("device-1");
    expect(attempt.studyComponentId).toBe(instance.componentKey);
    expect(attempt.entryId).toBe(instance.entryId);
    expect(attempt.skillTypeId).toBe("bab_identification");
    expect(attempt.sourceField).toBeNull();
    expect(attempt.direction).toBeNull();
    expect(attempt.promptRef).toEqual(instance.promptRef);
    expect(attempt.correctAnswerRef).toEqual(instance.correctAnswerRef);
    expect(attempt.selectedAnswerRef).toEqual(selected);
    expect(attempt.isCorrect).toBe(true);
    expect(attempt.isFirstAttempt).toBe(true);
    expect(attempt.isReinforcement).toBe(false);
    expect(attempt.hintUsed).toBe(true);
    expect(attempt.hintType).toBe("bab");
    expect(attempt.responseTimeMs).toBe(1234);
    expect(attempt.questionPosition).toBe(3);
    expect(attempt.mode).toBe("mc");
    expect(attempt.questionInstanceId).toBe(instance.questionInstanceId);
    expect(attempt.questionSeed).toBe(instance.questionSeed);
    expect(attempt.questionGeneratorVersion).toBe(
      instance.questionGeneratorVersion,
    );
    expect(attempt.releaseId).toBe(instance.releaseId);
    expect(attempt.contentVersion).toBe(instance.contentVersion);
    // Event-time metadata.
    expect(attempt.occurredAtUtc).toBe("2026-07-17T09:30:00.000Z");
    expect(attempt.timezoneAtEvent).toBe("Asia/Karachi");
    expect(attempt.utcOffsetMinutesAtEvent).toBe(300);
    expect(attempt.localDateAtEvent).toBe("2026-07-17");
    expect(attempt.timezoneSource).toBe("user_setting");
  });

  it("allows a null selection (timed lapse), takes mode from the instance, rejects negative time", () => {
    const instance = timedInstance();
    const attempt = createAttemptRecord(
      {
        id: "attempt-2",
        sessionId: "session-1",
        userId: "user-1",
        deviceId: "device-1",
        instance,
        selectedAnswerRef: null,
        isCorrect: false,
        isFirstAttempt: true,
        isReinforcement: false,
        hint: { used: false, type: null },
        responseTimeMs: 0,
        perQuestionLimitMs: 20000,
      },
      clock,
    );
    expect(attempt.selectedAnswerRef).toBeNull();
    expect(attempt.perQuestionLimitMs).toBe(20000);
    expect(attempt.userId).toBe("user-1");
    // The delivery mode comes from the instance, never a separate input.
    expect(attempt.mode).toBe("timed");
    expect(attempt.mode).toBe(instance.deliveryMode);
    expect(() =>
      createAttemptRecord(
        {
          id: "x",
          sessionId: "s",
          userId: null,
          deviceId: "d",
          instance,
          selectedAnswerRef: null,
          isCorrect: false,
          isFirstAttempt: true,
          isReinforcement: false,
          hint: { used: false, type: null },
          responseTimeMs: -1,
          perQuestionLimitMs: null,
        },
        clock,
      ),
    ).toThrow();
  });

  it("rejects a non-finite response time at the standalone API", () => {
    const instance = mcInstance();
    for (const bad of [Number.NaN, Infinity]) {
      expect(() =>
        createAttemptRecord(
          {
            id: "x",
            sessionId: "s",
            userId: null,
            deviceId: "d",
            instance,
            selectedAnswerRef: null,
            isCorrect: false,
            isFirstAttempt: true,
            isReinforcement: false,
            hint: { used: false, type: null },
            responseTimeMs: bad,
            perQuestionLimitMs: null,
          },
          clock,
        ),
      ).toThrow();
    }
  });
});
