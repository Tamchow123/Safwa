import { readFileSync } from "node:fs";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
import { SOURCE_FORM_METADATA } from "@/lib/form-metadata";
import { DB_READ_TIMEOUT_MS } from "@/lib/with-timeout";
import type { SourceQuizFormField } from "@/modules/content/constants";
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

// Fresh guest: no durable profile at init (read-only), bound on first grade.
const peekDeviceProfile = vi.fn(async () => null);
vi.mock("@/modules/profile/device", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/device")>();
  return {
    ...original,
    peekDeviceProfile: (...args: Parameters<typeof peekDeviceProfile>) =>
      peekDeviceProfile(...args),
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

// The session-frozen effective clock (Phase 12): deterministic by default;
// individual tests override with mockResolvedValueOnce to prove the resolved
// zone reaches the persisted attempt.
const readEffectiveClock = vi.fn(
  async (): Promise<import("@/modules/study-engine").AttemptClock> => ({
    now: () => Date.now(),
    timezone: "UTC",
    timezoneSource: "browser_detected",
  }),
);

vi.mock("@/modules/profile/timezone", async (importActual) => {
  const actual =
    await importActual<typeof import("@/modules/profile/timezone")>();
  return {
    ...actual,
    readEffectiveClock: (...args: Parameters<typeof readEffectiveClock>) =>
      readEffectiveClock(...args),
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
  readEffectiveClock.mockClear();
  peekDeviceProfile.mockClear();
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

/** The learner entry backing the current question (programmatic, by id). */
function entryFor(session: HTMLElement) {
  const entryId = Number(session.getAttribute("data-entry-id"));
  const entry = built.learner.entries.find(
    (candidate) => candidate.id === entryId,
  );
  if (!entry) throw new Error(`entry ${entryId} not in built release`);
  return entry;
}

/** Switch to an English→Arabic session for one specific source form. */
async function startRecallSession(
  user: ReturnType<typeof userEvent.setup>,
  field: SourceQuizFormField,
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "English → Arabic" }));
  await user.selectOptions(screen.getByLabelText("Form"), field);
  return waitFor(() => {
    const el = screen.getByTestId("mc-quiz-session");
    if (el.getAttribute("data-source-field") !== field) {
      throw new Error(`not a ${field} session yet`);
    }
    return el;
  });
}

describe("McQuizSession", () => {
  it("stamps attempts from the session-frozen effective clock (§10.5/§10.6)", async () => {
    // 2026-07-17T20:00Z is already 2026-07-18 05:00 in Asia/Tokyo (+09:00) —
    // the attempt's immutable event-time fields must follow the RESOLVED
    // user-setting zone, not UTC and not the test environment's zone.
    const fixedNowMs = Date.UTC(2026, 6, 17, 20, 0, 0);
    readEffectiveClock.mockResolvedValueOnce({
      now: () => fixedNowMs,
      timezone: "Asia/Tokyo",
      timezoneSource: "user_setting",
    });

    const user = userEvent.setup();
    render(<McQuizSession />);
    const session = await waitForQuestion();
    await user.click(optionWithRef(correctRef(session)));

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    expect(readEffectiveClock).toHaveBeenCalledTimes(1); // frozen per mount
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.timezoneAtEvent).toBe("Asia/Tokyo");
    expect(attempt.timezoneSource).toBe("user_setting");
    expect(attempt.localDateAtEvent).toBe("2026-07-18");
    expect(attempt.utcOffsetMinutesAtEvent).toBe(540);
    expect(attempt.occurredAtUtc).toBe(new Date(fixedNowMs).toISOString());
  });

  it("auto-starts and shows a question with four options", async () => {
    render(<McQuizSession />);
    const session = await waitForQuestion();
    expect(session).toBeInTheDocument();
    expect(screen.getByText(/Question 1 of/)).toBeInTheDocument();
    // §4.5: exactly four options, and the quizzed form is not named yet.
    expect(options()).toHaveLength(4);
    expect(screen.queryByTestId("mc-form-reveal")).toBeNull();
    // Ar→En asks for the BASE meaning — never "the translation" of the form —
    // and does not label the Arabic prompt with a base-meaning label.
    expect(screen.getByTestId("mc-prompt-caption")).toHaveTextContent(
      "Choose the base meaning",
    );
    expect(screen.queryByTestId("mc-base-meaning-label")).toBeNull();
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

    // Feedback marks the outcome correct, shows the entry's BASE meaning
    // labelled as such, and reveals the quizzed form via the shared metadata —
    // never wording that claims an exact form translation.
    const feedback = await screen.findByTestId("mc-feedback");
    expect(within(feedback).getByTestId("mc-feedback-outcome")).toHaveAttribute(
      "data-correct",
      "true",
    );
    expect(sourceField).toBeTruthy();
    const reveal = screen.getByTestId("mc-form-reveal");
    expect(reveal.textContent).toBe(
      `Form: ${SOURCE_FORM_METADATA[sourceField as SourceQuizFormField].label}`,
    );
    expect(screen.getByTestId("mc-base-meaning").textContent).toBe(
      `Base meaning: ${entryFor(session).meaning}`,
    );

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
    // The requested form is named BEFORE answering (the base meaning alone
    // cannot distinguish forms), and the prompt gloss is labelled as a base
    // meaning taken verbatim from the learner release.
    const sourceField = session.getAttribute(
      "data-source-field",
    ) as SourceQuizFormField;
    expect(screen.getByTestId("mc-prompt-caption").textContent).toBe(
      `Choose the ${SOURCE_FORM_METADATA[sourceField].name} form`,
    );
    expect(screen.getByTestId("mc-base-meaning-label")).toHaveTextContent(
      "Base meaning",
    );
    expect(session.textContent).toContain(entryFor(session).meaning);
  });

  it.each(["mudari", "masdar"] as const)(
    "a selected %s component asks for that form, constrains options and records sourceField",
    async (field) => {
      const user = userEvent.setup();
      render(<McQuizSession />);
      await waitForQuestion();

      const session = await startRecallSession(user, field);
      // The requested form is named before answering, from shared metadata.
      expect(screen.getByTestId("mc-prompt-caption").textContent).toBe(
        `Choose the ${SOURCE_FORM_METADATA[field].name} form`,
      );
      // Every option is the SAME eligible source field.
      expect(options()).toHaveLength(4);
      for (const option of options()) {
        expect(option.getAttribute("data-answer-ref")).toMatch(
          new RegExp(`:field:${field}$`),
        );
      }

      await user.click(optionWithRef(correctRef(session)));
      await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
      // The attempt still records the quizzed source field.
      expect(recordGradedAttempt.mock.calls[0][1].sourceField).toBe(field);
    },
  );

  it("keeps amr and nahy visibly distinct in prompts and metadata", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    await waitForQuestion();

    await startRecallSession(user, "amr");
    const amrCaption = screen.getByTestId("mc-prompt-caption").textContent!;
    expect(amrCaption).toBe(`Choose the ${SOURCE_FORM_METADATA.amr.name} form`);

    await startRecallSession(user, "nahi");
    const nahiCaption = screen.getByTestId("mc-prompt-caption").textContent!;
    expect(nahiCaption).toBe(
      `Choose the ${SOURCE_FORM_METADATA.nahi.name} form`,
    );

    // The two prompts (and their metadata) can never read the same.
    expect(nahiCaption).not.toBe(amrCaption);
    expect(SOURCE_FORM_METADATA.amr.description).not.toBe(
      SOURCE_FORM_METADATA.nahi.description,
    );
  });

  it("random-form English→Arabic questions update the visible form label per question", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    await waitForQuestion();

    // En→Ar with the default "Any eligible form" (random) field choice.
    await user.click(screen.getByRole("button", { name: "English → Arabic" }));
    await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el.getAttribute("data-prompt-field") !== "meaning") {
        throw new Error("still recognition");
      }
    });

    const seen = new Set<string>();
    // 8 questions: the chance a seeded random plan draws a single form eight
    // times is negligible, so the >1-forms assertion below is stable.
    for (let position = 1; position <= 8; position++) {
      const session = screen.getByTestId("mc-quiz-session");
      const sourceField = session.getAttribute(
        "data-source-field",
      ) as SourceQuizFormField;
      seen.add(sourceField);
      // The caption always names THIS question's form.
      expect(screen.getByTestId("mc-prompt-caption").textContent).toBe(
        `Choose the ${SOURCE_FORM_METADATA[sourceField].name} form`,
      );
      await user.click(optionWithRef(correctRef(session)));
      await user.click(await screen.findByTestId("mc-next"));
      await waitFor(() =>
        expect(
          screen.getByText(new RegExp(`Question ${position + 1} of`)),
        ).toBeInTheDocument(),
      );
    }
    // Across several random questions more than one form appeared, so the
    // label demonstrably tracked the per-question source field.
    expect(seen.size).toBeGreaterThan(1);
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
      // at the end rather than inline — §4.3/§4.4). Because this screen is the
      // ONLY feedback in test mode, the gloss must be labelled as a base
      // meaning here too, with the form label from the shared metadata.
      const sourceField = outcome.getAttribute("data-source-field");
      expect(sourceField).toBeTruthy();
      expect(outcome.textContent).toContain("Base meaning: ");
      expect(
        within(outcome).getByTestId("mc-result-form").textContent,
      ).toContain(
        `Form: ${SOURCE_FORM_METADATA[sourceField as SourceQuizFormField].label}`,
      );
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

  it("never artificially times out a slow-but-eventually-successful grading write (P1 regression guard)", async () => {
    // Regression guard: quiz-runner.tsx's grading write is explicitly
    // MIRRORED with flashcard-session.tsx's (see its own "P1 regression
    // guard" test) — this proves the same guarantee holds here too, since
    // the two write paths must never drift out of sync. Promise.race can't
    // cancel the underlying Dexie transaction, so a "timed out" write can
    // still commit later, duplicating the review row.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let resolveWrite: (() => void) | undefined;
    recordGradedAttempt.mockImplementationOnce(
      (_db, attempt, ctx) =>
        new Promise<PersistedAttempt>((resolve) => {
          resolveWrite = () =>
            resolve({
              attemptId: attempt.id,
              componentKey: attempt.studyComponentId,
              eventId: attempt.isReinforcement ? null : ctx.eventId,
              deviceId: attempt.deviceId,
            });
        }),
    );
    render(<McQuizSession />);
    const session = await waitForQuestion();
    await user.click(optionWithRef(correctRef(session)));

    // No timer exists on this path at all today (that is the fix) — this
    // advance is a tripwire against a FUTURE re-wrap, not an exercise of a
    // currently-live timeout. Still queued well past the OLD (removed) 15s
    // DB_WRITE_TIMEOUT_MS: no artificial failure may ever be surfaced while
    // the real write is still in flight.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Question 1 of/)).toBeInTheDocument();
    expect(screen.queryByTestId("mc-feedback")).toBeNull();

    // The write finally lands, successfully.
    resolveWrite?.();
    await waitFor(() =>
      expect(screen.getByTestId("mc-feedback")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("bounds a hung session-init read, and a late resolution never revives it (REL-P101)", async () => {
    // A blocked IndexedDB open (e.g. another tab mid schema-upgrade) must
    // surface the recoverable error within DB_READ_TIMEOUT_MS — and once
    // shown, that error is TERMINAL: the connection clearing moments later
    // must never silently flip the screen back to a live session with no
    // user action (MIRRORED in flashcard-session.test.tsx).
    vi.useFakeTimers();
    let resolveClock: (() => void) | undefined;
    readEffectiveClock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClock = () =>
            resolve({
              now: () => Date.now(),
              timezone: "UTC",
              timezoneSource: "browser_detected",
            });
        }),
    );
    render(<McQuizSession />);
    // Flush the (fast) useSessionDefaults settle first so QuizRunner mounts
    // and starts its OWN session-init read before advancing its budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DB_READ_TIMEOUT_MS + 1);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);

    // The blocked connection finally clears — but the timeout already fired.
    resolveClock?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);
    expect(screen.queryByTestId("mc-quiz-session")).toBeNull();
  });

  it("makes the timeout terminal regardless of WHICH init read hangs (checkpoint-agnostic, REL-P101)", async () => {
    // The guard is one shared `cancelled` flag checked before every side
    // effect, not a special case for the first await — prove a hang further
    // into initialisation (peekDeviceProfile) is bounded the same way
    // (MIRRORED in flashcard-session.test.tsx).
    vi.useFakeTimers();
    let resolveProfile: (() => void) | undefined;
    peekDeviceProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfile = () => resolve(null);
        }),
    );
    render(<McQuizSession />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DB_READ_TIMEOUT_MS + 1);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);

    resolveProfile?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);
    expect(screen.queryByTestId("mc-quiz-session")).toBeNull();
  });
});

describe("McQuizSession — hints (§4.4, Phase 11)", () => {
  it("offers hints, reveals the taken hint, and records it on the attempt", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    const session = await waitForQuestion();

    // The hint bar offers at least the first-letter hint (always derivable
    // for a base-meaning answer).
    const hintButton = screen.getByTestId("hint-first_letter");
    await user.click(hintButton);

    // The revealed hint replaces the offer bar and warns about reduced credit.
    const display = await screen.findByTestId("hint-display");
    expect(display).toHaveAttribute("data-hint-type", "first_letter");
    expect(display.textContent).toMatch(/partial credit/i);
    // The (focused) hint button just disappeared: focus moves to the display
    // card so keyboard users keep a visible position.
    await waitFor(() => expect(display).toHaveFocus());
    expect(screen.queryByTestId("hint-first_letter")).toBeNull();
    expect(session).toHaveAttribute("data-hint-used", "true");
    expect(session).toHaveAttribute("data-hint-type", "first_letter");

    // A correct answer after the hint records hint usage on the attempt —
    // the scheduler maps hinted-correct to Hard from exactly these fields.
    await user.click(optionWithRef(correctRef(session)));
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.hintUsed).toBe(true);
    expect(attempt.hintType).toBe("first_letter");
    expect(attempt.isCorrect).toBe(true);
  });

  it("records hint usage on an incorrect answer too (hinted incorrect ⇒ Again)", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    const session = await waitForQuestion();

    await user.click(screen.getByTestId("hint-first_letter"));
    await screen.findByTestId("hint-display");
    await user.click(anIncorrectOption(session));

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.hintUsed).toBe(true);
    expect(attempt.hintType).toBe("first_letter");
    expect(attempt.isCorrect).toBe(false);
  });

  it("a fresh question starts with no hint taken", async () => {
    const user = userEvent.setup();
    render(<McQuizSession />);
    let session = await waitForQuestion();

    await user.click(screen.getByTestId("hint-first_letter"));
    await screen.findByTestId("hint-display");
    await user.click(optionWithRef(correctRef(session)));
    await screen.findByTestId("mc-feedback");
    await user.click(screen.getByTestId("mc-next"));

    session = await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el.getAttribute("data-hint-used") !== "false") {
        throw new Error("hint state not reset yet");
      }
      return el;
    });
    // The offer bar is back; the second attempt records no hint.
    expect(screen.getByTestId("hint-first_letter")).toBeInTheDocument();
    await user.click(optionWithRef(correctRef(session)));
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(2));
    const [, attempt] = recordGradedAttempt.mock.calls[1];
    expect(attempt.hintUsed).toBe(false);
    expect(attempt.hintType).toBeNull();
  });
});

describe("McQuizSession — hint state survives a failed persistence write", () => {
  it("a timed retry after a failed write stays hinted (Hard, never upgraded to Good)", async () => {
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

    // Take a hint, then answer on time — but the write fails transiently.
    await user.click(screen.getByTestId("hint-first_letter"));
    await screen.findByTestId("hint-display");
    recordGradedAttempt.mockImplementationOnce(async () => {
      throw new Error("indexeddb unavailable");
    });
    const session = screen.getByTestId("mc-quiz-session");
    await user.click(optionWithRef(correctRef(session)));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i),
    );

    // The view remounted for a fresh countdown, but the hint exposure is
    // learning state owned by the runner: still displayed, still recorded.
    expect(screen.getByTestId("hint-display")).toBeInTheDocument();
    expect(screen.getByTestId("mc-quiz-session")).toHaveAttribute(
      "data-hint-used",
      "true",
    );

    recordGradedAttempt.mockClear();
    await user.click(
      optionWithRef(correctRef(screen.getByTestId("mc-quiz-session"))),
    );
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    // Hinted correct: the retry must persist the hint (the scheduler maps
    // exactly these fields to Hard) — a transient failure can never upgrade
    // a hinted answer to full credit.
    expect(attempt.isCorrect).toBe(true);
    expect(attempt.hintUsed).toBe(true);
    expect(attempt.hintType).toBe("first_letter");
  });
});
