/**
 * Custom session setup screen (Phase 11, §4.4): every documented filter is
 * present and composes; the empty-result guard suggests loosening; timed and
 * test COMBINE; flashcards disable timed/test; the bookmarks/lists placeholder
 * is visible but disabled until Phase 14.
 */
import { readFileSync } from "node:fs";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { AttemptRecord } from "@/modules/study-engine";
import type {
  PersistedAttempt,
  RecordAttemptContext,
  SchedulingSnapshot,
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

const emptySnapshot: SchedulingSnapshot = {
  components: [],
  attempts: [],
  events: [],
};
const readSchedulingSnapshot = vi.fn(async () => emptySnapshot);

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
    readSchedulingSnapshot: (
      ...args: Parameters<typeof readSchedulingSnapshot>
    ) => readSchedulingSnapshot(...args),
    recordGradedAttempt: (...args: Parameters<typeof recordGradedAttempt>) =>
      recordGradedAttempt(...args),
  };
});

// The session-frozen effective clock (Phase 12): deterministic by default;
// the single-resolution test overrides once to prove the snapshot clock is
// threaded to the runner rather than re-resolved.
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

import { CustomSession } from "@/components/study/custom-session";

afterEach(() => {
  vi.useRealTimers();
  readSchedulingSnapshot.mockClear();
  recordGradedAttempt.mockClear();
  readEffectiveClock.mockClear();
});

async function renderSetup() {
  render(<CustomSession />);
  return waitFor(() => screen.getByTestId("custom-setup"), { timeout: 4000 });
}

describe("CustomSession — setup screen (§4.4 filter matrix)", () => {
  it("shows every documented filter control", async () => {
    await renderSetup();
    // Mode
    for (const mode of ["mc", "flashcards", "bab", "root"]) {
      expect(screen.getByTestId(`custom-mode-${mode}`)).toBeInTheDocument();
    }
    // Direction (translation modes)
    expect(
      screen.getByTestId("custom-direction-arabic_to_english"),
    ).toBeInTheDocument();
    // Forms
    for (const field of [
      "madi",
      "mudari",
      "masdar",
      "ism_fail",
      "amr",
      "nahi",
    ]) {
      expect(screen.getByTestId(`custom-form-${field}`)).toBeInTheDocument();
    }
    // Bāb buttons render the Arabic pair from the release, never a number.
    const firstBab = built.learner.entries[0];
    const babButton = screen.getByTestId(`custom-bab-${firstBab.bab}`);
    expect(babButton.textContent).toContain(firstBab.bab_arabic);
    expect(babButton.textContent).not.toMatch(/[0-9IVX]/);
    // Verb type, states, pages, count, timing, test, bookmarks placeholder.
    expect(screen.getByTestId("custom-verbtype-sahih")).toBeInTheDocument();
    for (const state of ["new", "learning", "mastered", "weak", "due"]) {
      expect(screen.getByTestId(`custom-state-${state}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("custom-page-min")).toBeInTheDocument();
    expect(screen.getByTestId("custom-page-max")).toBeInTheDocument();
    expect(screen.getByTestId("custom-count")).toHaveValue(20);
    expect(screen.getByTestId("custom-timed")).toBeInTheDocument();
    expect(screen.getByTestId("custom-test-mode")).toBeInTheDocument();
    const placeholder = screen.getByTestId("custom-bookmarks-placeholder");
    expect(placeholder.querySelector("button")).toBeDisabled();
  });

  it("empty-result guard: an impossible combination suggests loosening filters", async () => {
    const user = userEvent.setup();
    await renderSetup();
    // A fresh guest has no stored progress: mastered-only matches nothing.
    await user.click(screen.getByTestId("custom-state-mastered"));
    await user.click(screen.getByTestId("custom-start"));

    const guard = await screen.findByTestId("custom-empty-guard");
    expect(guard).toBeInTheDocument();
    // Announced and focused: a screen-reader user must learn the start
    // produced no session (the guard mounts with its content, so focus —
    // not just a live region — carries the announcement).
    expect(guard).toHaveAttribute("role", "status");
    await waitFor(() => expect(guard).toHaveFocus());
    const suggestions = screen.getAllByTestId("loosen-suggestion");
    expect(suggestions.map((node) => node.textContent)).toContain(
      "Include every progress state",
    );
    // No session was mounted.
    expect(screen.queryByTestId("mc-quiz-session")).not.toBeInTheDocument();
  });

  it("composes the demonstrate case: one bāb + maṣdar only + timed", async () => {
    const user = userEvent.setup();
    await renderSetup();

    const targetBab = built.learner.entries[0].bab;
    await user.click(screen.getByTestId("custom-form-masdar"));
    await user.click(screen.getByTestId(`custom-bab-${targetBab}`));
    await user.click(screen.getByTestId("custom-timed"));
    await user.click(screen.getByTestId("custom-start"));

    const session = await screen.findByTestId("mc-quiz-session", undefined, {
      timeout: 4000,
    });
    expect(session).toHaveAttribute("data-delivery", "timed");
    expect(session).toHaveAttribute("data-source-field", "masdar");
    expect(screen.getByTestId("mc-timer")).toBeInTheDocument();
    // The quizzed entry belongs to the selected bāb.
    const entryId = Number(session.getAttribute("data-entry-id"));
    const entry = built.learner.entries.find((e) => e.id === entryId)!;
    expect(entry.bab).toBe(targetBab);
  });

  it("combines timed + test: countdown shown, inline feedback withheld", async () => {
    const user = userEvent.setup();
    await renderSetup();

    await user.click(screen.getByTestId("custom-timed"));
    await user.click(screen.getByTestId("custom-test-mode"));
    await user.click(screen.getByTestId("custom-start"));

    const session = await screen.findByTestId("mc-quiz-session", undefined, {
      timeout: 4000,
    });
    expect(session).toHaveAttribute("data-delivery", "timed_test");
    expect(screen.getByTestId("mc-timer")).toBeInTheDocument();

    // Answer: no inline feedback (test semantics) — the next question mounts.
    const first = screen.getAllByTestId("mc-option")[0];
    await user.click(first);
    await waitFor(() => {
      expect(screen.queryByTestId("mc-feedback")).not.toBeInTheDocument();
    });
    // The attempt was recorded with the combined delivery mode.
    expect(recordGradedAttempt).toHaveBeenCalled();
    const attempt = recordGradedAttempt.mock.calls[0][1];
    expect(attempt.mode).toBe("timed_test");
  });

  it("flashcards mode disables timed/test and launches the flashcard runner", async () => {
    const user = userEvent.setup();
    await renderSetup();

    await user.click(screen.getByTestId("custom-mode-flashcards"));
    expect(screen.getByTestId("custom-timed")).toBeDisabled();
    expect(screen.getByTestId("custom-test-mode")).toBeDisabled();

    await user.click(screen.getByTestId("custom-start"));
    const card = await screen.findByTestId("flashcard-session", undefined, {
      timeout: 4000,
    });
    expect(card).toBeInTheDocument();
  });

  it("Study again re-reads the scheduling snapshot (never a stale pre-session map)", async () => {
    const user = userEvent.setup();
    await renderSetup();
    // A one-question session so the results screen is one answer away.
    await user.clear(screen.getByTestId("custom-count"));
    await user.type(screen.getByTestId("custom-count"), "1");
    await user.click(screen.getByTestId("custom-start"));

    const session = await screen.findByTestId("mc-quiz-session", undefined, {
      timeout: 4000,
    });
    expect(readSchedulingSnapshot).toHaveBeenCalledTimes(1);

    // Answer the single question correctly and finish.
    const entryId = session.getAttribute("data-entry-id");
    const answerField = session.getAttribute("data-answer-field");
    const correct = screen
      .getAllByTestId("mc-option")
      .find(
        (option) =>
          option.getAttribute("data-answer-ref") ===
          `entry:${entryId}:field:${answerField}`,
      )!;
    await user.click(correct);
    await user.click(await screen.findByTestId("mc-next"));
    await screen.findByTestId("mc-results");

    // Study again goes through the full start path: the persisted state is
    // read AGAIN so state filters see what this session just recorded.
    await user.click(screen.getByTestId("study-again"));
    await screen.findByTestId("mc-quiz-session", undefined, { timeout: 4000 });
    expect(readSchedulingSnapshot).toHaveBeenCalledTimes(2);
  });

  it("resolves the effective clock ONCE per session and stamps attempts with it (§10.6)", async () => {
    // 2026-07-17T20:00Z is already 2026-07-18 in Asia/Tokyo (+09:00).
    const fixedNowMs = Date.UTC(2026, 6, 17, 20, 0, 0);
    readEffectiveClock.mockResolvedValueOnce({
      now: () => fixedNowMs,
      timezone: "Asia/Tokyo",
      timezoneSource: "user_setting",
    });

    const user = userEvent.setup();
    await renderSetup();
    await user.click(screen.getByTestId("custom-start"));
    await screen.findByTestId("mc-quiz-session", undefined, { timeout: 4000 });

    await user.click(screen.getAllByTestId("mc-option")[0]);
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalled());

    // ONE resolution for the whole session: start()'s snapshot clock is
    // threaded into the runner via presetClock — the runner must never
    // re-resolve (a second call would return the default UTC clock and the
    // stamped zone below would betray it).
    expect(readEffectiveClock).toHaveBeenCalledTimes(1);
    const attempt = recordGradedAttempt.mock.calls[0][1];
    expect(attempt.timezoneAtEvent).toBe("Asia/Tokyo");
    expect(attempt.timezoneSource).toBe("user_setting");
    expect(attempt.localDateAtEvent).toBe("2026-07-18");
    expect(attempt.utcOffsetMinutesAtEvent).toBe(540);
  });

  it("flashcards mode also resolves the effective clock ONCE and stamps with it", async () => {
    // The flashcards branch shares no code with the quiz branch beyond the
    // identical presetClock ?? readEffectiveClock line in FlashcardRunner —
    // prove the single resolution independently for it.
    const fixedNowMs = Date.UTC(2026, 6, 17, 20, 0, 0);
    readEffectiveClock.mockResolvedValueOnce({
      now: () => fixedNowMs,
      timezone: "Asia/Tokyo",
      timezoneSource: "user_setting",
    });

    const user = userEvent.setup();
    await renderSetup();
    await user.click(screen.getByTestId("custom-mode-flashcards"));
    await user.click(screen.getByTestId("custom-start"));
    const card = await screen.findByTestId("flashcard", undefined, {
      timeout: 4000,
    });

    await user.click(card); // flip to reveal
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalled());

    expect(readEffectiveClock).toHaveBeenCalledTimes(1);
    const attempt = recordGradedAttempt.mock.calls[0][1];
    expect(attempt.timezoneAtEvent).toBe("Asia/Tokyo");
    expect(attempt.timezoneSource).toBe("user_setting");
    expect(attempt.localDateAtEvent).toBe("2026-07-18");
    expect(attempt.utcOffsetMinutesAtEvent).toBe(540);
  });

  it("adjust filters returns from a running session to the setup screen", async () => {
    const user = userEvent.setup();
    await renderSetup();
    await user.click(screen.getByTestId("custom-start"));
    await screen.findByTestId("mc-quiz-session", undefined, { timeout: 4000 });

    await user.click(screen.getByTestId("custom-adjust-filters"));
    expect(await screen.findByTestId("custom-setup")).toBeInTheDocument();
  });
});
