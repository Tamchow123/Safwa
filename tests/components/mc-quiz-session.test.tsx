import { readFileSync } from "node:fs";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { AttemptRecord } from "@/modules/study-engine";
import type {
  PersistedAttempt,
  RecordAttemptContext,
} from "@/modules/study-session/persistence";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));

const readyState: ActiveContentState = {
  status: "ready",
  entries: built.learner.entries,
  releaseId: built.releaseId,
  contentVersion: built.learner.content_version,
  questionGeneratorVersion: built.learner.question_generator_version,
  entryCount: built.learner.entries.length,
  source: "cache",
};

vi.mock("@/components/content/use-active-content", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/content/use-active-content")
    >();
  return {
    ...original,
    useActiveContent: () => ({ state: readyState, retry: vi.fn() }),
  };
});

vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});

vi.mock("@/modules/profile/device", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/device")>();
  return {
    ...original,
    // Fresh guest: no durable profile at init (read-only), bound on first grade.
    peekDeviceProfile: vi.fn(async () => null),
  };
});

const ensureDurableGuestStateSpy = vi.fn(async () => ({ deviceId: "dev-1" }));

vi.mock("@/modules/profile/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/persistence")>();
  return {
    ...original,
    ensureDurableGuestState: (
      ...args: Parameters<typeof ensureDurableGuestStateSpy>
    ) => ensureDurableGuestStateSpy(...args),
  };
});

const recordGradedAttempt = vi.fn(
  async (
    _db: unknown,
    attempt: AttemptRecord,
    ctx: RecordAttemptContext,
  ): Promise<PersistedAttempt> => ({
    attemptId: attempt.id,
    componentKey: attempt.studyComponentId,
    // Reinforcement recoveries create no event; mirror that in the mock.
    eventId: attempt.isReinforcement ? null : ctx.eventId,
    deviceId: attempt.deviceId,
  }),
);
const undoGradedAttempt = vi.fn(async () => {});

vi.mock("@/modules/study-session/persistence", async (importActual) => {
  const actual =
    await importActual<typeof import("@/modules/study-session/persistence")>();
  return {
    ...actual,
    recordGradedAttempt: (...args: Parameters<typeof recordGradedAttempt>) =>
      recordGradedAttempt(...args),
    undoGradedAttempt: (...args: Parameters<typeof undoGradedAttempt>) =>
      undoGradedAttempt(...args),
  };
});

import { McQuizSession } from "@/components/study/mc-quiz-session";

afterEach(() => {
  // Always restore real timers so a fake-timer test can never leak its paused
  // clock into a later test (which would hang every async wait).
  vi.useRealTimers();
  recordGradedAttempt.mockClear();
  undoGradedAttempt.mockClear();
  ensureDurableGuestStateSpy.mockClear();
  vi.restoreAllMocks();
});

/** Wait for the first question to render and return its container. */
async function waitForQuestion(): Promise<HTMLElement> {
  return waitFor(() => screen.getByTestId("mc-quiz-session"), {
    timeout: 4000,
  });
}

/** The serialized ref of the correct option — always the prompt entry's answer
 * field (distractors are drawn from OTHER entries). */
function correctRef(session: HTMLElement): string {
  const entryId = session.getAttribute("data-entry-id");
  const answerField = session.getAttribute("data-answer-field");
  return `entry:${entryId}:field:${answerField}`;
}

function options(): HTMLElement[] {
  return screen.getAllByTestId("mc-option");
}

function optionWithRef(ref: string): HTMLElement {
  const found = options().find(
    (option) => option.getAttribute("data-answer-ref") === ref,
  );
  if (!found) throw new Error(`no option with ref ${ref}`);
  return found;
}

function anIncorrectOption(session: HTMLElement): HTMLElement {
  const correct = correctRef(session);
  const found = options().find(
    (option) => option.getAttribute("data-answer-ref") !== correct,
  );
  if (!found) throw new Error("no incorrect option present");
  return found;
}

describe("McQuizSession", () => {
  it("auto-starts and shows a question with four options", async () => {
    render(<McQuizSession />);
    const session = await waitForQuestion();
    expect(session).toBeInTheDocument();
    expect(screen.getByText(/Question 1 of/)).toBeInTheDocument();
    // §4.5: exactly four options, and the quizzed form is not named yet.
    expect(options()).toHaveLength(4);
    expect(screen.queryByTestId("mc-form-reveal")).toBeNull();
  });

  it("answering correctly shows immediate feedback and reveals the form", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    const session = await waitForQuestion();
    const sourceField = session.getAttribute("data-source-field");

    await user.click(optionWithRef(correctRef(session)));

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.mode).toBe("mc");
    expect(attempt.isCorrect).toBe(true);

    // Feedback marks the outcome correct and reveals the source form by name.
    const feedback = await screen.findByTestId("mc-feedback");
    expect(within(feedback).getByTestId("mc-feedback-outcome")).toHaveAttribute(
      "data-correct",
      "true",
    );
    const reveal = screen.getByTestId("mc-form-reveal");
    // The reveal names the actual quizzed source form (read from the DOM, not a
    // hand-typed Arabic literal).
    expect(reveal.textContent).toMatch(/This was the .+ form\./);
    expect(sourceField).toBeTruthy();

    // A Next control advances the session.
    expect(screen.getByTestId("mc-next")).toBeEnabled();
  });

  it("answering incorrectly re-queues the question in-session", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    const session = await waitForQuestion();
    const totalBefore = Number(
      /Question 1 of (\d+)/.exec(
        screen.getByText(/Question 1 of/).textContent!,
      )![1],
    );

    await user.click(anIncorrectOption(session));

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    expect(recordGradedAttempt.mock.calls[0][1].isCorrect).toBe(false);

    const feedback = await screen.findByTestId("mc-feedback");
    expect(within(feedback).getByTestId("mc-feedback-outcome")).toHaveAttribute(
      "data-correct",
      "false",
    );

    // Advance; a wrong first attempt added one reinforcement item to the plan.
    await user.click(screen.getByTestId("mc-next"));
    await waitFor(() => {
      const total = Number(
        /Question 2 of (\d+)/.exec(
          screen.getByText(/Question 2 of/).textContent!,
        )![1],
      );
      expect(total).toBe(totalBefore + 1);
    });
  });

  it("English→Arabic mode prompts with the meaning and offers Arabic options", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    await waitForQuestion();

    // Switch to En→Ar; the runner remounts a fresh recall session.
    await user.click(screen.getByRole("button", { name: "English → Arabic" }));

    const session = await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el.getAttribute("data-answer-field") === "meaning") {
        throw new Error("still recognition");
      }
      return el;
    });
    // Recall: the prompt is the meaning, the answer is a source form.
    expect(session.getAttribute("data-prompt-field")).toBe("meaning");
    expect(session.getAttribute("data-answer-field")).not.toBe("meaning");
  });

  it("test mode withholds per-question feedback but reveals it in the results", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    await waitForQuestion();

    await user.selectOptions(screen.getByTestId("mc-delivery-select"), "test");

    // Answer a handful of questions; feedback must never appear inline.
    for (let i = 0; i < 6; i++) {
      if (screen.queryByTestId("mc-results")) break;
      const session = screen.getByTestId("mc-quiz-session");
      await user.click(optionWithRef(correctRef(session)));
      expect(screen.queryByTestId("mc-feedback")).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Force completion by finishing the (20-question) session quickly.
    for (let i = 0; i < 40; i++) {
      if (screen.queryByTestId("mc-results")) break;
      const session = screen.queryByTestId("mc-quiz-session");
      if (!session) break;
      await user.click(optionWithRef(correctRef(session)));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const results = await screen.findByTestId("mc-results", undefined, {
      timeout: 4000,
    });
    // Per-question outcomes are revealed only now (withheld until the end).
    const breakdown = within(results).getByTestId("mc-test-breakdown");
    const outcomes = within(breakdown).getAllByTestId("mc-result-outcome");
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      // Every answer above was the correct option.
      expect(outcome).toHaveAttribute("data-correct", "true");
      // The quizzed source form is revealed for every row (test mode reveals it
      // at the end rather than inline — §4.3/§4.4).
      const sourceField = outcome.getAttribute("data-source-field");
      expect(sourceField).toBeTruthy();
      expect(within(outcome).getByTestId("mc-result-form")).toBeInTheDocument();
    }
  });

  it("marks the chosen and correct options after answering", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    const session = await waitForQuestion();
    const correct = correctRef(session);
    // Choose a WRONG option: the chosen one is marked as the selection and the
    // correct one is marked correct — state conveyed by data attributes (and a
    // visible text badge, not colour alone).
    const wrong = anIncorrectOption(session);
    const wrongRef = wrong.getAttribute("data-answer-ref")!;
    await user.click(wrong);

    await screen.findByTestId("mc-feedback");
    const correctOption = optionWithRef(correct);
    const chosenOption = optionWithRef(wrongRef);
    expect(correctOption).toHaveAttribute("data-correct", "true");
    expect(correctOption).toHaveAttribute("data-selected", "false");
    expect(chosenOption).toHaveAttribute("data-selected", "true");
    expect(chosenOption).toHaveAttribute("data-correct", "false");
    // Non-colour cues: the correct option names itself, the wrong one is marked.
    expect(correctOption).toHaveTextContent(/correct answer/i);
    expect(chosenOption).toHaveTextContent(/your answer/i);
  });

  it("counts a wrong-then-corrected component as recovered in the results", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    const first = await waitForQuestion();

    // Fail the first question (re-queues its component once), then answer every
    // remaining question — including the re-queued reinforcement — correctly.
    await user.click(anIncorrectOption(first));
    await screen.findByTestId("mc-feedback");
    await user.click(screen.getByTestId("mc-next"));

    for (let i = 0; i < 60; i++) {
      if (screen.queryByTestId("mc-results")) break;
      const session = screen.queryByTestId("mc-quiz-session");
      if (!session) break;
      await user.click(optionWithRef(correctRef(session)));
      const next = screen.queryByTestId("mc-next");
      if (next) await user.click(next);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const results = await screen.findByTestId("mc-results", undefined, {
      timeout: 4000,
    });
    // 20 components seen; exactly one was wrong-then-corrected. The results
    // distinguish first-attempt correct (19) from recovered (1) — acceptance
    // criterion 7 — and no hint UI exists yet, so hinted is 0.
    expect(within(results).getByTestId("mc-questions")).toHaveTextContent("20");
    expect(
      within(results).getByTestId("mc-first-attempt-correct"),
    ).toHaveTextContent("19");
    expect(within(results).getByTestId("mc-recovered")).toHaveTextContent("1");
    expect(within(results).getByTestId("mc-hinted")).toHaveTextContent("0");
  });

  it("an all-correct session reports every question correct first try", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    await waitForQuestion();

    for (let i = 0; i < 60; i++) {
      if (screen.queryByTestId("mc-results")) break;
      const session = screen.queryByTestId("mc-quiz-session");
      if (!session) break;
      await user.click(optionWithRef(correctRef(session)));
      const next = screen.queryByTestId("mc-next");
      if (next) await user.click(next);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const results = await screen.findByTestId("mc-results", undefined, {
      timeout: 4000,
    });
    // A full 20-question session answered correctly: all first-attempt correct,
    // nothing recovered or hinted (no re-queue happened).
    expect(within(results).getByTestId("mc-questions")).toHaveTextContent("20");
    expect(
      within(results).getByTestId("mc-first-attempt-correct"),
    ).toHaveTextContent("20");
    expect(within(results).getByTestId("mc-recovered")).toHaveTextContent("0");
    expect(within(results).getByTestId("mc-hinted")).toHaveTextContent("0");
  });

  it("timed mode records an incorrect lapse when the countdown expires", async () => {
    // shouldAdvanceTime lets async init + waitFor progress on their own, while
    // advanceTimersByTimeAsync jumps the per-question countdown past the limit.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<McQuizSession />);
    await waitFor(() => screen.getByTestId("mc-quiz-session"), {
      timeout: 4000,
    });

    // Switch to timed mode; the runner remounts a timed session with a
    // per-question countdown.
    await user.selectOptions(screen.getByTestId("mc-delivery-select"), "timed");
    await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el.getAttribute("data-delivery") !== "timed") {
        throw new Error("not timed yet");
      }
      return el;
    });
    expect(screen.getByTestId("mc-timer")).toBeInTheDocument();

    // Let the 20s limit lapse without answering.
    await vi.advanceTimersByTimeAsync(21000);

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    // The lapse is an incorrect timed attempt with no selection recorded.
    expect(attempt.mode).toBe("timed");
    expect(attempt.isCorrect).toBe(false);
    expect(attempt.selectedAnswerRef).toBeNull();

    // The feedback names the lapse (never a contradictory "your answer").
    const feedback = await screen.findByTestId("mc-feedback");
    expect(feedback).toHaveTextContent(/time's up/i);
    expect(within(feedback).getByTestId("mc-feedback-outcome")).toHaveAttribute(
      "data-correct",
      "false",
    );
  });

  it("a failed timed write resets the countdown so the retry is not a lapse", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<McQuizSession />);
    await waitFor(() => screen.getByTestId("mc-quiz-session"), {
      timeout: 4000,
    });
    await user.selectOptions(screen.getByTestId("mc-delivery-select"), "timed");
    await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el.getAttribute("data-delivery") !== "timed") {
        throw new Error("not timed yet");
      }
      return el;
    });

    // Answer ON TIME (15s in), but the persistence write fails transiently.
    await vi.advanceTimersByTimeAsync(15000);
    recordGradedAttempt.mockImplementationOnce(async () => {
      throw new Error("indexeddb unavailable");
    });
    const session = screen.getByTestId("mc-quiz-session");
    await user.click(optionWithRef(correctRef(session)));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i),
    );

    // The countdown reset for the retry (fresh mount) rather than continuing
    // toward the original deadline.
    const timer = await screen.findByTestId("mc-timer");
    expect(Number.parseInt(timer.textContent ?? "0", 10)).toBeGreaterThan(15);

    // Cross the ORIGINAL deadline (15s + 6s = 21s > 20s), then retry: with the
    // fresh clock this is an on-time correct answer, NOT a lapse — and the old
    // expiry timer must not have auto-submitted one either.
    await vi.advanceTimersByTimeAsync(6000);
    recordGradedAttempt.mockClear();
    await user.click(
      optionWithRef(correctRef(screen.getByTestId("mc-quiz-session"))),
    );
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.isCorrect).toBe(true);
    expect(attempt.selectedAnswerRef).not.toBeNull();
  });

  it("undoing a timed lapse restores a fresh countdown and lets it be answered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<McQuizSession />);
    await waitFor(() => screen.getByTestId("mc-quiz-session"), {
      timeout: 4000,
    });
    await user.selectOptions(screen.getByTestId("mc-delivery-select"), "timed");
    await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el.getAttribute("data-delivery") !== "timed") {
        throw new Error("not timed yet");
      }
      return el;
    });

    // Expire the countdown, then UNDO directly from the feedback state.
    await vi.advanceTimersByTimeAsync(21000);
    await screen.findByTestId("mc-feedback");
    await user.click(screen.getByTestId("undo"));
    await waitFor(() => expect(undoGradedAttempt).toHaveBeenCalledTimes(1));

    // The restored question is presented fresh: feedback gone, and the countdown
    // is reset to (near) the full limit rather than stuck at zero.
    await waitFor(() => expect(screen.queryByTestId("mc-feedback")).toBeNull());
    const timer = await screen.findByTestId("mc-timer");
    expect(Number.parseInt(timer.textContent ?? "0", 10)).toBeGreaterThan(1);

    // The question is answerable again — a click now is NOT read as a lapse
    // (the response-time clock restarted with the fresh mount).
    recordGradedAttempt.mockClear();
    const session = screen.getByTestId("mc-quiz-session");
    await user.click(optionWithRef(correctRef(session)));
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.isCorrect).toBe(true);
    expect(attempt.selectedAnswerRef).not.toBeNull();
  });

  it("undoes exactly the last graded question once", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    const session = await waitForQuestion();

    expect(screen.getByTestId("undo")).toBeDisabled();
    await user.click(optionWithRef(correctRef(session)));
    await screen.findByTestId("mc-feedback");
    await user.click(screen.getByTestId("mc-next"));
    await waitFor(() =>
      expect(screen.getByText(/Question 2 of/)).toBeInTheDocument(),
    );

    const undoButton = screen.getByTestId("undo");
    expect(undoButton).toBeEnabled();
    await user.click(undoButton);

    await waitFor(() => expect(undoGradedAttempt).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/Question 1 of/)).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByTestId("undo")).toBeDisabled());
  });

  it("surfaces a retryable error and does not advance when persistence fails", async () => {
    const user = userEvent.setup();
    recordGradedAttempt.mockImplementationOnce(async () => {
      throw new Error("indexeddb unavailable");
    });
    render(<McQuizSession />);
    const session = await waitForQuestion();

    await user.click(optionWithRef(correctRef(session)));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i),
    );
    // The session stays on question 1 with no feedback shown.
    expect(screen.getByText(/Question 1 of/)).toBeInTheDocument();
    expect(screen.queryByTestId("mc-feedback")).toBeNull();
  });
});
