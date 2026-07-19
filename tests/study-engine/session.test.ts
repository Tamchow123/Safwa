import { describe, expect, it } from "vitest";

import type { AttemptClock } from "@/modules/study-engine/attempts";
import type { AnswerReference } from "@/modules/content/answer-reference";
import {
  canUndo,
  createSession,
  currentQuestion,
  revealResults,
  submitAnswer,
  summarizeSession,
  undo,
  type SessionState,
  type SubmitAnswerInput,
} from "@/modules/study-engine/session";

import { questionContext } from "./fixtures";

const clock: AttemptClock = {
  now: () => Date.UTC(2026, 6, 17, 9, 30, 0),
  timezone: "Asia/Karachi",
  timezoneSource: "user_setting",
};

/** Deterministic injected attempt-id factory for tests. */
function idFactory() {
  let n = 0;
  return () => `attempt-${n++}`;
}

function submit(
  state: SessionState,
  nextId: () => string,
  input: Omit<
    SubmitAnswerInput,
    "attemptId" | "clock" | "questionInstanceId"
  > & {
    questionInstanceId?: string;
  },
) {
  const current = currentQuestion(state, questionContext);
  return submitAnswer(state, questionContext, {
    questionInstanceId: current?.questionInstanceId ?? "none",
    ...input,
    attemptId: nextId(),
    clock,
  });
}

function correctRef(state: SessionState): AnswerReference {
  const question = currentQuestion(state, questionContext)!;
  return question.options.find((o) => o.isCorrect)!.ref;
}

function wrongRef(state: SessionState): AnswerReference {
  const question = currentQuestion(state, questionContext)!;
  return question.options.find((o) => !o.isCorrect)!.ref;
}

function babSession(overrides = {}) {
  return createSession(
    {
      sessionId: "s1",
      seed: "seed",
      deviceId: "device-1",
      items: [{ identity: { entryId: 1, skillType: "bab_identification" } }],
      ...overrides,
    },
    questionContext,
  );
}

describe("session — wrong-then-correct reinforcement", () => {
  it("produces [incorrect(first), correct(reinforcement)] and completes", () => {
    const nextId = idFactory();
    let state = babSession();

    const first = submit(state, nextId, {
      selectedAnswerRef: wrongRef(state),
      responseTimeMs: 800,
    });
    state = first.state;
    expect(first.attempt.isCorrect).toBe(false);
    expect(first.attempt.isFirstAttempt).toBe(true);
    expect(first.attempt.isReinforcement).toBe(false);
    expect(first.attempt.id).toBe("attempt-0");
    expect(first.feedback?.isCorrect).toBe(false);
    expect(state.status).toBe("active");
    expect(state.plan).toHaveLength(2);

    const second = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 600,
    });
    state = second.state;
    expect(second.attempt.isCorrect).toBe(true);
    expect(second.attempt.isFirstAttempt).toBe(false);
    expect(second.attempt.isReinforcement).toBe(true);
    expect(state.status).toBe("complete");

    expect(state.attempts.map((a) => [a.isCorrect, a.isReinforcement])).toEqual(
      [
        [false, false],
        [true, true],
      ],
    );
    const components = new Set(state.attempts.map((a) => a.studyComponentId));
    expect(components.size).toBe(1);
  });
});

describe("session — single-step undo", () => {
  it("removes exactly the last attempt and reverts the re-queue", () => {
    const nextId = idFactory();
    let state = babSession();
    const before = state;

    const result = submit(state, nextId, {
      selectedAnswerRef: wrongRef(state),
      responseTimeMs: 500,
    });
    state = result.state;
    expect(state.attempts).toHaveLength(1);
    expect(state.plan).toHaveLength(2);
    expect(canUndo(state)).toBe(true);

    const reverted = undo(state);
    expect(reverted.attempts).toHaveLength(0);
    expect(reverted.plan).toHaveLength(1);
    expect(reverted.currentIndex).toBe(0);
    expect(reverted).toEqual(before);

    expect(canUndo(reverted)).toBe(false);
    expect(() => undo(reverted)).toThrow();
  });
});

describe("session — timed mode (limit enforced from response time)", () => {
  it("marks a correct selection past the limit as incorrect (time-derived)", () => {
    const nextId = idFactory();
    const state = babSession({
      config: { timed: true, perQuestionLimitMs: 20000 },
    });
    const result = submit(state, nextId, {
      selectedAnswerRef: correctRef(state), // a CORRECT selection...
      responseTimeMs: 20001, // ...but over the limit
    });
    expect(result.attempt.isCorrect).toBe(false);
    expect(result.attempt.selectedAnswerRef).toBeNull();
    expect(result.attempt.mode).toBe("timed");
  });

  it("accepts an on-time answer normally and grades it", () => {
    const nextId = idFactory();
    const state = babSession({
      config: { timed: true, perQuestionLimitMs: 20000 },
    });
    const result = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 19999,
    });
    expect(result.attempt.isCorrect).toBe(true);
    expect(result.attempt.selectedAnswerRef).not.toBeNull();
  });

  it("treats a response exactly at the limit as expired (>= boundary)", () => {
    const nextId = idFactory();
    const state = babSession({
      config: { timed: true, perQuestionLimitMs: 20000 },
    });
    const result = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 20000, // exactly the limit
    });
    expect(result.attempt.isCorrect).toBe(false);
    expect(result.attempt.selectedAnswerRef).toBeNull();
  });

  it("records a lapse (no answer past the limit) as incorrect", () => {
    const nextId = idFactory();
    const state = babSession({
      config: { timed: true, perQuestionLimitMs: 20000 },
    });
    // A lapse: no selection, elapsed time past the limit.
    const result = submit(state, nextId, { responseTimeMs: 30000 });
    expect(result.attempt.isCorrect).toBe(false);
    expect(result.attempt.selectedAnswerRef).toBeNull();
  });

  it("combines timed + test (Phase 11): timed_test mode, feedback withheld, lapse counted", () => {
    const nextId = idFactory();
    let state = babSession({ config: { timed: true, testMode: true } });
    // The combined composition is its own recorded delivery mode, so the
    // attempt is never mislabelled as plain timed or plain test.
    expect(state.config.perQuestionLimitMs).toBe(20000);
    const question = currentQuestion(state, questionContext)!;
    expect(question.deliveryMode).toBe("timed_test");

    // A lapse past the limit counts as incorrect AND feedback stays withheld
    // (test-mode semantics) until the session completes.
    const lapse = submit(state, nextId, { responseTimeMs: 30000 });
    state = lapse.state;
    expect(lapse.attempt.mode).toBe("timed_test");
    expect(lapse.attempt.isCorrect).toBe(false);
    expect(lapse.attempt.selectedAnswerRef).toBeNull();
    expect(lapse.feedback).toBeNull();
    expect(() => revealResults(state)).toThrow(); // re-queued, still active

    // Finish the reinforcement re-queue on time; results reveal at the end.
    const recovery = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 900,
    });
    state = recovery.state;
    expect(recovery.feedback).toBeNull();
    expect(state.status).toBe("complete");
    expect(revealResults(state).map((outcome) => outcome.isCorrect)).toEqual([
      false,
      true,
    ]);
  });

  it("rejects an invalid (non-positive / non-finite) timed limit", () => {
    expect(() =>
      babSession({ config: { timed: true, perQuestionLimitMs: 0 } }),
    ).toThrow();
    expect(() =>
      babSession({ config: { timed: true, perQuestionLimitMs: Number.NaN } }),
    ).toThrow();
  });

  it("defaults a timed session to the documented 20s limit", () => {
    const nextId = idFactory();
    const state = babSession({ config: { timed: true } }); // no explicit limit
    expect(state.config.perQuestionLimitMs).toBe(20000);
    const result = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 25000, // past the defaulted limit
    });
    expect(result.attempt.isCorrect).toBe(false);
  });

  it("refuses to create a flashcard session with an entry-level item", () => {
    expect(() =>
      createSession(
        {
          sessionId: "bad-flash",
          seed: "seed",
          deviceId: "d",
          config: { mode: "flashcard" },
          items: [
            { identity: { entryId: 1, skillType: "bab_identification" } },
          ],
        },
        questionContext,
      ),
    ).toThrow();
  });

  it("refuses to create a test-mode flashcard session", () => {
    expect(() =>
      createSession(
        {
          sessionId: "tflash",
          seed: "seed",
          deviceId: "d",
          config: { mode: "flashcard", testMode: true },
          items: [
            {
              identity: {
                entryId: 1,
                skillType: "meaning_recognition",
                sourceField: "madi",
                direction: "arabic_to_english",
              },
            },
          ],
        },
        questionContext,
      ),
    ).toThrow();
  });

  it("refuses to create a timed flashcard session", () => {
    expect(() =>
      createSession(
        {
          sessionId: "tf",
          seed: "seed",
          deviceId: "d",
          config: { mode: "flashcard", timed: true },
          items: [
            {
              identity: {
                entryId: 1,
                skillType: "meaning_recognition",
                sourceField: "madi",
                direction: "arabic_to_english",
              },
            },
          ],
        },
        questionContext,
      ),
    ).toThrow();
  });
});

describe("session — test mode withholds feedback but still reinforces", () => {
  it("withholds feedback inline, re-queues a wrong item, reveals only at the end", () => {
    const nextId = idFactory();
    let state = createSession(
      {
        sessionId: "test-mode",
        seed: "seed",
        deviceId: "device-1",
        config: { testMode: true },
        items: [{ identity: { entryId: 1, skillType: "bab_identification" } }],
      },
      questionContext,
    );

    const first = submit(state, nextId, {
      selectedAnswerRef: wrongRef(state),
      responseTimeMs: 700,
    });
    state = first.state;
    expect(first.attempt.mode).toBe("test");
    // Feedback withheld inline...
    expect(first.feedback).toBeNull();
    // ...the persisted attempt still carries correctness for the server.
    expect(typeof first.attempt.isCorrect).toBe("boolean");
    // Reinforcement STILL re-queues in test mode (§4.6) — only feedback waits.
    expect(state.plan).toHaveLength(2);
    expect(state.status).toBe("active");
    // Results withheld while the session is active.
    expect(() => revealResults(state)).toThrow();

    const second = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 500,
    });
    state = second.state;
    expect(second.feedback).toBeNull();
    expect(second.attempt.isReinforcement).toBe(true);
    expect(state.status).toBe("complete");

    const results = revealResults(state);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.isCorrect)).toEqual([false, true]);
  });

  it("gives immediate feedback outside test mode", () => {
    const nextId = idFactory();
    const state = babSession();
    const result = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 500,
    });
    expect(result.feedback).not.toBeNull();
    expect(result.feedback?.isCorrect).toBe(true);
    expect(revealResults(result.state)).toHaveLength(1);
  });
});

describe("session — flashcards and multi-item flow", () => {
  it("tracks first attempts across multiple components", () => {
    const nextId = idFactory();
    let state = createSession(
      {
        sessionId: "multi",
        seed: "seed",
        deviceId: "device-1",
        userId: "user-9",
        config: { mode: "flashcard" },
        items: [
          {
            identity: {
              entryId: 1,
              skillType: "meaning_recognition",
              sourceField: "madi",
              direction: "arabic_to_english",
            },
          },
          {
            identity: {
              entryId: 2,
              skillType: "meaning_recognition",
              sourceField: "madi",
              direction: "arabic_to_english",
            },
          },
        ],
      },
      questionContext,
    );

    const a = submit(state, nextId, { selfGrade: "know", responseTimeMs: 300 });
    state = a.state;
    const b = submit(state, nextId, {
      selfGrade: "dont_know",
      responseTimeMs: 400,
    });
    state = b.state;

    expect(a.attempt.isFirstAttempt).toBe(true);
    expect(a.attempt.isCorrect).toBe(true);
    expect(a.attempt.mode).toBe("flashcard");
    expect(a.attempt.userId).toBe("user-9");
    expect(b.attempt.isFirstAttempt).toBe(true);
    expect(b.attempt.isCorrect).toBe(false);
    // "I don't know" re-queues for reinforcement within the session.
    expect(state.plan).toHaveLength(3);
    expect(state.firstAttemptedComponents).toHaveLength(2);
  });

  it("requires the right input per mode and blocks submit after completion", () => {
    const nextId = idFactory();
    const state = babSession();
    expect(() => submit(state, nextId, { responseTimeMs: 100 })).toThrow(); // MC needs a selection

    const done = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 100,
    }).state;
    expect(done.status).toBe("complete");
    expect(() =>
      submit(done, nextId, {
        selectedAnswerRef: { entryId: 1, field: "bab" },
        responseTimeMs: 100,
      }),
    ).toThrow();
  });

  it("rejects a contradictory hint state at submit", () => {
    const nextId = idFactory();
    const state = babSession();
    expect(() =>
      submit(state, nextId, {
        selectedAnswerRef: correctRef(state),
        responseTimeMs: 100,
        // @ts-expect-error — contradictory hint state rejected at runtime
        hint: { used: true, type: null },
      }),
    ).toThrow();
  });

  it("defaults userId to null for a guest", () => {
    const nextId = idFactory();
    const state = babSession();
    expect(state.userId).toBeNull();
    const result = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 100,
    });
    expect(result.attempt.userId).toBeNull();
  });
});

describe("session — wrong-then-correct completes in every mode", () => {
  type Mode = "mc" | "test" | "timed" | "flashcard";

  function sessionFor(mode: Mode) {
    const config =
      mode === "test"
        ? { testMode: true }
        : mode === "timed"
          ? { timed: true, perQuestionLimitMs: 20000 }
          : mode === "flashcard"
            ? { mode: "flashcard" as const }
            : {};
    const items =
      mode === "flashcard"
        ? [
            {
              identity: {
                entryId: 1,
                skillType: "meaning_recognition" as const,
                sourceField: "madi" as const,
                direction: "arabic_to_english" as const,
              },
            },
          ]
        : [
            {
              identity: {
                entryId: 1,
                skillType: "bab_identification" as const,
              },
            },
          ];
    return createSession(
      {
        sessionId: `recover-${mode}`,
        seed: "seed",
        deviceId: "device-1",
        config,
        items,
      },
      questionContext,
    );
  }

  for (const mode of ["mc", "test", "timed", "flashcard"] as const) {
    it(`yields [incorrect(first), correct(reinforcement)] and completes — ${mode}`, () => {
      const nextId = idFactory();
      let state = sessionFor(mode);

      const wrong =
        mode === "flashcard"
          ? { selfGrade: "dont_know" as const, responseTimeMs: 500 }
          : { selectedAnswerRef: wrongRef(state), responseTimeMs: 500 };
      const first = submit(state, nextId, wrong);
      state = first.state;
      expect(first.attempt.isCorrect).toBe(false);
      expect(first.attempt.isFirstAttempt).toBe(true);
      expect(first.attempt.isReinforcement).toBe(false);
      // Reinforcement re-queued in every mode.
      expect(state.status).toBe("active");
      expect(state.plan).toHaveLength(2);

      const right =
        mode === "flashcard"
          ? { selfGrade: "know" as const, responseTimeMs: 500 }
          : { selectedAnswerRef: correctRef(state), responseTimeMs: 500 };
      const second = submit(state, nextId, right);
      state = second.state;
      expect(second.attempt.isCorrect).toBe(true);
      expect(second.attempt.isFirstAttempt).toBe(false);
      // The scheduling-suppression indicator Phase 7 relies on.
      expect(second.attempt.isReinforcement).toBe(true);
      expect(state.status).toBe("complete");
      expect(
        state.attempts.map((a) => [a.isCorrect, a.isReinforcement]),
      ).toEqual([
        [false, false],
        [true, true],
      ]);
    });
  }
});

describe("session — scripted seeded transcript (deterministic replay)", () => {
  type TranscriptStep = {
    position: number;
    componentKey: string;
    promptField: string;
    optionRefs: string[];
    selected: string | null;
    isCorrect: boolean;
    isReinforcement: boolean;
  };

  /** Play a session to completion with a fixed answer strategy; return a
   * fully-serialisable transcript. First attempts on even positions answer
   * correctly, odd positions answer wrong (exercising reinforcement). */
  function runScriptedSession(): TranscriptStep[] {
    const nextId = idFactory();
    let state = createSession(
      {
        sessionId: "transcript",
        seed: "fixed-seed",
        deviceId: "device-1",
        items: [
          { identity: { entryId: 1, skillType: "bab_identification" } },
          { identity: { entryId: 2, skillType: "bab_identification" } },
          {
            identity: {
              entryId: 3,
              skillType: "meaning_recognition",
              sourceField: "madi",
              direction: "arabic_to_english",
            },
          },
        ],
      },
      questionContext,
    );

    const transcript: TranscriptStep[] = [];
    let guard = 0;
    while (state.status === "active") {
      if (guard++ > 20) throw new Error("session did not terminate");
      const question = currentQuestion(state, questionContext)!;
      const answerCorrectly = question.position % 2 === 0;
      const ref = answerCorrectly ? correctRef(state) : wrongRef(state);
      const result = submit(state, nextId, {
        selectedAnswerRef: ref,
        responseTimeMs: 1000,
      });
      transcript.push({
        position: question.position,
        componentKey: question.componentKey,
        promptField: question.promptField,
        optionRefs: question.options.map(
          (o) => `${o.ref.entryId}:${o.ref.field}`,
        ),
        selected: `${ref.entryId}:${ref.field}`,
        isCorrect: result.attempt.isCorrect,
        isReinforcement: result.attempt.isReinforcement,
      });
      state = result.state;
    }
    return transcript;
  }

  it("replays a fixed seed to a byte-identical transcript", () => {
    const first = runScriptedSession();
    const second = runScriptedSession();
    // The entire scripted sequence — not just isolated questions — is
    // deterministic: same seed ⇒ identical transcript.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // Structural sanity: position 1 was answered wrong and reinforced later.
    const wrongFirst = first.find((s) => s.position === 1)!;
    expect(wrongFirst.isCorrect).toBe(false);
    expect(wrongFirst.isReinforcement).toBe(false);
    const reinforcement = first.find((s) => s.isReinforcement);
    expect(reinforcement).toBeDefined();
    // Every step has exactly four option refs.
    expect(first.every((s) => s.optionRefs.length === 4)).toBe(true);
  });
});

describe("session — independently planned repeats are not reinforcement", () => {
  it("a component planned twice (varied prompt forms) is never mislabeled recovered", () => {
    const nextId = idFactory();
    // The SAME bāb component, planned twice with different prompt forms — both
    // are fresh "initial" items (bāb is one component regardless of prompt).
    let state = createSession(
      {
        sessionId: "repeat",
        seed: "seed",
        deviceId: "device-1",
        items: [
          {
            identity: { entryId: 1, skillType: "bab_identification" },
            promptForm: "madi",
          },
          {
            identity: { entryId: 1, skillType: "bab_identification" },
            promptForm: "mudari",
          },
        ],
      },
      questionContext,
    );

    const first = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 400,
    });
    state = first.state;
    const second = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 400,
    });
    state = second.state;

    expect(first.attempt.isFirstAttempt).toBe(true);
    expect(first.attempt.isReinforcement).toBe(false);
    // Second exposure: NOT the first attempt, but NOT a reinforcement either.
    expect(second.attempt.isFirstAttempt).toBe(false);
    expect(second.attempt.isReinforcement).toBe(false);

    const summary = summarizeSession(state);
    expect(summary.recovered).toBe(0);
    expect(summary.firstAttemptCorrect).toBe(1);
  });
});

describe("session — content pinning and submission binding", () => {
  it("rejects a context from a different release mid-session (even same content_version)", () => {
    const state = babSession();
    // Same human-readable content_version, DIFFERENT authoritative release_id —
    // pinning keys off release_id, so this must still be rejected.
    const otherRelease = {
      ...questionContext,
      releaseId: `${questionContext.releaseId}-corrected`,
    };
    expect(() => currentQuestion(state, otherRelease)).toThrow();
    expect(() =>
      submitAnswer(state, otherRelease, {
        attemptId: "a",
        questionInstanceId: "x",
        selectedAnswerRef: { entryId: 1, field: "bab" },
        responseTimeMs: 100,
        clock,
      }),
    ).toThrow();
  });

  it("rejects a stale submission bound to a different question instance", () => {
    const nextId = idFactory();
    const state = babSession();
    expect(() =>
      submit(state, nextId, {
        selectedAnswerRef: correctRef(state),
        responseTimeMs: 100,
        questionInstanceId: "stale-instance-id",
      }),
    ).toThrow();
  });

  it("accepts a submission bound to the current question instance", () => {
    const nextId = idFactory();
    const state = babSession();
    const current = currentQuestion(state, questionContext)!;
    const result = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 100,
      questionInstanceId: current.questionInstanceId,
    });
    expect(result.attempt.questionInstanceId).toBe(current.questionInstanceId);
  });
});

describe("session — hint boundary validation", () => {
  it("rejects an explicit null hint (not silently coerced to no-hint)", () => {
    const nextId = idFactory();
    const state = babSession();
    expect(() =>
      submit(state, nextId, {
        selectedAnswerRef: correctRef(state),
        responseTimeMs: 100,
        // @ts-expect-error — null hint is invalid and must be rejected
        hint: null,
      }),
    ).toThrow();
  });
});

describe("session — summary", () => {
  it("counts a component wrong on both first and reinforcement as repeatedIncorrect", () => {
    const nextId = idFactory();
    let state = babSession();
    state = submit(state, nextId, {
      selectedAnswerRef: wrongRef(state),
      responseTimeMs: 500,
    }).state; // wrong first attempt → reinforcement re-queued
    const second = submit(state, nextId, {
      selectedAnswerRef: wrongRef(state),
      responseTimeMs: 500,
    }); // wrong reinforcement
    state = second.state;
    expect(second.attempt.isReinforcement).toBe(true);
    expect(second.attempt.isCorrect).toBe(false);
    expect(state.status).toBe("complete");

    const summary = summarizeSession(state);
    expect(summary.recovered).toBe(0);
    expect(summary.repeatedIncorrect).toBe(1);
  });

  it("counts recovered vs repeated-incorrect components", () => {
    const nextId = idFactory();
    let state = babSession();
    state = submit(state, nextId, {
      selectedAnswerRef: wrongRef(state),
      responseTimeMs: 500,
    }).state;
    state = submit(state, nextId, {
      selectedAnswerRef: correctRef(state),
      responseTimeMs: 500,
    }).state;

    const summary = summarizeSession(state);
    expect(summary.totalAttempts).toBe(2);
    expect(summary.firstAttemptCorrect).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(summary.repeatedIncorrect).toBe(0);
    expect(summary.componentsSeen).toBe(1);
  });
});

describe("session — attempts record the effective option count (Phase 11)", () => {
  it("persists the generated option count on every attempt (durable identity input)", () => {
    const nextId = idFactory();
    // Configured 8 on a bāb item: the generator clamps to the six bābs; the
    // attempt records the EFFECTIVE count the learner actually saw.
    const clamped = babSession({ config: { optionCount: 8 } });
    const clampedResult = submit(clamped, nextId, {
      selectedAnswerRef: correctRef(clamped),
      responseTimeMs: 700,
    });
    expect(clampedResult.attempt.optionCount).toBe(6);

    const plain = babSession();
    const plainResult = submit(plain, nextId, {
      selectedAnswerRef: correctRef(plain),
      responseTimeMs: 700,
    });
    expect(plainResult.attempt.optionCount).toBe(4);
  });

  it("persists the grading limit on timed attempts (null when untimed)", () => {
    const nextId = idFactory();
    // A configurable limit (Phase 11): the attempt records the exact limit it
    // was graded against, so authoritative regrading never guesses.
    const timed = babSession({
      config: { timed: true, perQuestionLimitMs: 5000 },
    });
    const timedResult = submit(timed, nextId, {
      selectedAnswerRef: correctRef(timed),
      responseTimeMs: 6000, // past THIS session's 5s limit
    });
    expect(timedResult.attempt.perQuestionLimitMs).toBe(5000);
    expect(timedResult.attempt.isCorrect).toBe(false); // graded against 5s

    const untimed = babSession();
    const untimedResult = submit(untimed, nextId, {
      selectedAnswerRef: correctRef(untimed),
      responseTimeMs: 6000,
    });
    expect(untimedResult.attempt.perQuestionLimitMs).toBeNull();
    expect(untimedResult.attempt.isCorrect).toBe(true);
  });
});
