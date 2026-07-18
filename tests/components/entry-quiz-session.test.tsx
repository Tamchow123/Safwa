import { readFileSync } from "node:fs";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
import { UNRESOLVED_ROOT_ENTRY_IDS } from "@/modules/content/constants";
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

vi.mock("@/modules/profile/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/persistence")>();
  return {
    ...original,
    ensureDurableGuestState: vi.fn(async () => ({ deviceId: "dev-1" })),
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
    eventId: attempt.isReinforcement ? null : ctx.eventId,
    deviceId: attempt.deviceId,
  }),
);

vi.mock("@/modules/study-session/persistence", async (importActual) => {
  const actual =
    await importActual<typeof import("@/modules/study-session/persistence")>();
  return {
    ...actual,
    recordGradedAttempt: (...args: Parameters<typeof recordGradedAttempt>) =>
      recordGradedAttempt(...args),
    undoGradedAttempt: vi.fn(async () => {}),
  };
});

import { EntryQuizSession } from "@/components/study/entry-quiz-session";
import { QuizRunner } from "@/components/study/quiz-runner";

afterEach(() => {
  recordGradedAttempt.mockClear();
  vi.restoreAllMocks();
});

const ARABIC = /[؀-ۿ]/;

/** Wait for the first question to render and return its container. */
async function waitForQuestion(): Promise<HTMLElement> {
  return waitFor(() => screen.getByTestId("mc-quiz-session"), {
    timeout: 4000,
  });
}

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

function entryFor(session: HTMLElement) {
  const entryId = Number(session.getAttribute("data-entry-id"));
  const entry = built.learner.entries.find(
    (candidate) => candidate.id === entryId,
  );
  if (!entry) throw new Error(`entry ${entryId} not in built release`);
  return entry;
}

describe("EntryQuizSession — bāb", () => {
  it("auto-starts with a māḍī prompt and Arabic-pair options, never numbering", async () => {
    render(<EntryQuizSession skill="bab_identification" />);
    const session = await waitForQuestion();

    expect(session.getAttribute("data-skill-type")).toBe("bab_identification");
    expect(session.getAttribute("data-answer-field")).toBe("bab");
    // Default prompt form is the māḍī.
    expect(session.getAttribute("data-prompt-field")).toBe("madi");
    expect(screen.getByTestId("mc-prompt-caption")).toHaveTextContent(
      "Choose the bāb",
    );

    // Every option is one of the release's Arabic bāb pairs: Arabic script,
    // no Latin transliteration, no digits, no Form I–VI numbering (hard rule 5).
    const babPairs = new Set(built.learner.entries.map((e) => e.bab_arabic));
    expect(options()).toHaveLength(4);
    for (const option of options()) {
      const text = option.textContent!.trim();
      expect(babPairs.has(text)).toBe(true);
      expect(text).toMatch(ARABIC);
      expect(text).not.toMatch(/[0-9A-Za-z]/);
    }
  });

  it("a configured muḍāriʿ prompt form is honoured and recorded on the attempt", async () => {
    const user = userEvent.setup();
    render(<EntryQuizSession skill="bab_identification" />);
    await waitForQuestion();

    await user.selectOptions(
      screen.getByTestId("prompt-form-select"),
      "mudari",
    );
    const session = await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el.getAttribute("data-prompt-field") !== "mudari") {
        throw new Error("not a mudari session yet");
      }
      return el;
    });
    // The prompted form is eligible for the shown entry (hard rule 2).
    expect(entryFor(session).quiz_eligibility.mudari).toBe(true);

    await user.click(optionWithRef(correctRef(session)));
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    // The prompt form is recorded on the attempt (entry-level components carry
    // it as the prompt field; sourceField stays null by shape).
    expect(attempt.skillTypeId).toBe("bab_identification");
    expect(attempt.promptField).toBe("mudari");
    expect(attempt.sourceField).toBeNull();
    expect(attempt.promptRef).toEqual({
      entryId: Number(session.getAttribute("data-entry-id")),
      field: "mudari",
    });
  });

  it("random prompt forms stay within each entry's eligible forms", async () => {
    const user = userEvent.setup();
    render(<EntryQuizSession skill="bab_identification" />);
    const before = await waitForQuestion();

    await user.selectOptions(
      screen.getByTestId("prompt-form-select"),
      "random",
    );
    // The select change remounts the runner (new key → new DOM node); a random
    // session's first prompt can coincidentally be "madi", so wait on node
    // identity rather than an attribute value.
    await waitFor(() => {
      const el = screen.getByTestId("mc-quiz-session");
      if (el === before) throw new Error("still the previous session");
      return el;
    });

    for (let i = 0; i < 4; i++) {
      const session = screen.getByTestId("mc-quiz-session");
      const promptField = session.getAttribute("data-prompt-field")!;
      const entry = entryFor(session);
      expect(
        entry.quiz_eligibility[
          promptField as keyof typeof entry.quiz_eligibility
        ],
      ).toBe(true);
      await user.click(optionWithRef(correctRef(session)));
      await user.click(await screen.findByTestId("mc-next"));
      await waitFor(() =>
        expect(
          screen.getByText(new RegExp(`Question ${i + 2} of`)),
        ).toBeInTheDocument(),
      );
    }
  });
});

describe("QuizRunner — feedback eligibility guard (hard rule 2)", () => {
  it("omits the base meaning for an entry whose meaning is not quiz-eligible", async () => {
    const user = userEvent.setup();
    // Synthetic release state: one real bāb-eligible entry with its meaning
    // marked ineligible (no such entry exists in the current dataset — the
    // guard is structural). The bāb component stays valid; the feedback must
    // not teach the ineligible meaning.
    const target = built.learner.entries.find(
      (candidate) =>
        candidate.quiz_eligibility.bab && candidate.quiz_eligibility.madi,
    )!;
    const entries = built.learner.entries.map((candidate) =>
      candidate.id === target.id
        ? {
            ...candidate,
            quiz_eligibility: {
              ...candidate.quiz_eligibility,
              meaning: false,
            },
          }
        : candidate,
    );

    render(
      <QuizRunner
        entries={entries}
        releaseId={built.releaseId}
        contentVersion={built.learner.content_version}
        questionGeneratorVersion={built.learner.question_generator_version}
        buildPlan={() => [
          {
            identity: {
              entryId: target.id,
              skillType: "bab_identification" as const,
            },
            promptForm: "madi" as const,
          },
        ]}
        delivery="immediate"
        emptyMessage="empty"
        onStudyAgain={() => {}}
      />,
    );
    const session = await waitForQuestion();
    expect(Number(session.getAttribute("data-entry-id"))).toBe(target.id);

    await user.click(optionWithRef(correctRef(session)));
    await screen.findByTestId("mc-feedback");
    // The ineligible meaning is never shown; the form reveal still is.
    expect(screen.queryByTestId("mc-base-meaning")).toBeNull();
    expect(screen.getByTestId("mc-form-reveal")).toBeInTheDocument();
  });
});

describe("EntryQuizSession — root", () => {
  it("asks for the root with root options and reveals the prompt form in feedback", async () => {
    const user = userEvent.setup();
    render(<EntryQuizSession skill="root_identification" />);
    const session = await waitForQuestion();

    expect(session.getAttribute("data-skill-type")).toBe("root_identification");
    expect(session.getAttribute("data-answer-field")).toBe("root");
    expect(screen.getByTestId("mc-prompt-caption")).toHaveTextContent(
      "Choose the root",
    );
    // Root options are Arabic three-radical values from OTHER eligible entries.
    for (const option of options()) {
      expect(option.getAttribute("data-answer-ref")).toMatch(/:field:root$/);
      expect(option.textContent!.trim()).toMatch(ARABIC);
    }

    await user.click(optionWithRef(correctRef(session)));
    // Feedback names the base meaning and the (māḍī) prompt form.
    await screen.findByTestId("mc-feedback");
    expect(screen.getByTestId("mc-base-meaning").textContent).toBe(
      `Base meaning: ${entryFor(session).meaning}`,
    );
    expect(screen.getByTestId("mc-form-reveal").textContent).toBe(
      "Form: Past (māḍī)",
    );
  });

  it("never quizzes the unresolved-root entries 369/372", async () => {
    const user = userEvent.setup();
    render(<EntryQuizSession skill="root_identification" />);
    await waitForQuestion();

    for (let i = 0; i < 5; i++) {
      const session = screen.getByTestId("mc-quiz-session");
      const entryId = Number(session.getAttribute("data-entry-id"));
      expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(entryId);
      for (const option of options()) {
        const ref = option.getAttribute("data-answer-ref")!;
        const optionEntryId = Number(/^entry:(\d+):/.exec(ref)![1]);
        expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(optionEntryId);
      }
      await user.click(optionWithRef(correctRef(session)));
      await user.click(await screen.findByTestId("mc-next"));
      await waitFor(() =>
        expect(
          screen.getByText(new RegExp(`Question ${i + 2} of`)),
        ).toBeInTheDocument(),
      );
    }
  });
});
