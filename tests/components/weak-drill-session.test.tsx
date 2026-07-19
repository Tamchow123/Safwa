/**
 * Weak drill session (Phase 13 §17-19, §27): a valid dimension/value request
 * starts a session containing only that group's currently-qualifying weak
 * component(s); an unknown/invalid dimension or value shows the safe
 * not-found state instead of starting a session; "Study this area again"
 * rebuilds the plan from a fresh weakness read and shows the encouraging
 * empty state once the area no longer qualifies as weak.
 *
 * Both `useWeaknessSnapshot` (request validation/header) and `buildPlan`
 * (session planning) read through the SAME mocked `readAnalyticsRawSnapshot`
 * — never two independently-seeded fixtures — so a real disagreement between
 * the two would surface as a test failure (§22).
 */
import { readFileSync } from "node:fs";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WeakDrillSession } from "@/components/study/weak-drill-session";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { AnalyticsAttempt } from "@/modules/analytics/activity";
import type { AnalyticsRawRead } from "@/modules/analytics/persistence";
import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import type { SessionDefaults } from "@/modules/profile/session-defaults";
import { deriveAllComponents } from "@/modules/study-engine/components";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const derived = deriveAllComponents(built.learner.entries);

const NOW_MS = Date.UTC(2026, 6, 19, 12, 0, 0);

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

vi.mock("@/modules/profile/timezone", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/timezone")>();
  return {
    ...original,
    readEffectiveClock: vi.fn(async () => ({
      now: () => NOW_MS,
      timezone: "UTC",
      timezoneSource: "browser_detected" as const,
    })),
  };
});

vi.mock("@/modules/profile/device", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/device")>();
  return { ...original, peekDeviceProfile: vi.fn(async () => null) };
});

vi.mock("@/modules/profile/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/persistence")>();
  return {
    ...original,
    ensureDurableGuestState: vi.fn(async () => ({ deviceId: "dev-1" })),
  };
});

vi.mock("@/modules/study-session/persistence", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/modules/study-session/persistence")
    >();
  return {
    ...original,
    recordGradedAttempt: vi.fn(async () => ({
      attemptId: "attempt-persisted",
      eventId: "event-persisted",
    })),
    undoGradedAttempt: vi.fn(),
  };
});

let mockedDefaults: SessionDefaults = {
  questionCount: 1,
  optionCount: 4,
  newPerDay: 10,
  reviewsPerDay: 20,
};
vi.mock("@/lib/preferences/use-session-defaults", () => ({
  useSessionDefaults: () => ({
    defaults: mockedDefaults,
    loaded: true,
    update: vi.fn(),
  }),
}));

const readAnalyticsRawSnapshot =
  vi.fn<(db: unknown) => Promise<AnalyticsRawRead>>();
vi.mock("@/modules/analytics/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/analytics/persistence")>();
  return {
    ...original,
    readAnalyticsRawSnapshot: (db: unknown) => readAnalyticsRawSnapshot(db),
  };
});

const emptySnapshot: AnalyticsRawRead = {
  components: [],
  attempts: [],
  events: [],
};

function isoAt(daysAgo: number, hourOfDay = 10): string {
  return new Date(
    Date.UTC(2026, 6, 19 - daysAgo, hourOfDay, 0, 0),
  ).toISOString();
}
function localDate(daysAgo: number): string {
  return isoAt(daysAgo, 0).slice(0, 10);
}

const usableCard = (lapses: number): SchedulerCard => ({
  stability: 5,
  difficulty: 6,
  dueAtMs: NOW_MS + 5 * 86_400_000,
  state: "review",
  reps: 3,
  lapses,
  scheduledDays: 5,
  learningSteps: 0,
  lastReviewAtMs: NOW_MS - 2 * 86_400_000,
});

const babEntry = built.learner.entries.find(
  (e) =>
    e.quiz_eligibility.bab &&
    derived.some(
      (c) => c.entryId === e.id && c.skillType === "bab_identification",
    ),
)!;
const babComponent = derived.find(
  (c) => c.entryId === babEntry.id && c.skillType === "bab_identification",
)!;

let attemptCounter = 0;
function attempt(overrides: Partial<AnalyticsAttempt>): AnalyticsAttempt {
  attemptCounter += 1;
  return {
    id: `attempt-${attemptCounter}`,
    componentKey: babComponent.key,
    localDateAtEvent: localDate(0),
    responseTimeMs: 1_000,
    occurredAtUtc: isoAt(0),
    entryId: babEntry.id,
    skillType: "bab_identification",
    direction: null,
    sourceField: null,
    promptField: "madi",
    isFirstAttempt: true,
    isReinforcement: false,
    isCorrect: false,
    ...overrides,
  };
}

/** Enough recent incorrect first attempts + a lapse to qualify as weak. */
const weakSnapshot: AnalyticsRawRead = {
  components: [
    {
      componentKey: babComponent.key,
      learnerState: "learning",
      fsrs: usableCard(1),
    },
  ],
  attempts: [0, 1, 2, 3, 4].map((daysAgo) =>
    attempt({
      occurredAtUtc: isoAt(daysAgo),
      localDateAtEvent: localDate(daysAgo),
    }),
  ),
  events: [],
};

beforeEach(() => {
  mockedDefaults = {
    questionCount: 1,
    optionCount: 4,
    newPerDay: 10,
    reviewsPerDay: 20,
  };
  readAnalyticsRawSnapshot.mockReset();
  readAnalyticsRawSnapshot.mockResolvedValue(weakSnapshot);
});

afterEach(() => {
  attemptCounter = 0;
});

describe("valid weak-set drill (§17-18, §27 'drill button')", () => {
  it("starts a session containing only the requested group's weak component", async () => {
    render(<WeakDrillSession dimensionParam="bab" valueParam={babEntry.bab} />);
    const session = await screen.findByTestId("mc-quiz-session", undefined, {
      timeout: 4000,
    });
    expect(session).toHaveAttribute("data-entry-id", String(babEntry.id));
    expect(session).toHaveAttribute("data-skill-type", "bab_identification");
    expect(screen.getByText("Practising")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Weak Areas" }),
    ).toHaveAttribute("href", "/progress/weak-areas");
  });
});

describe("background weakness refresh mid-session (ARCH-001/ARCH-003 regression)", () => {
  it("never unmounts a live session when a tab-visibility refresh no longer surfaces the group", async () => {
    render(<WeakDrillSession dimensionParam="bab" valueParam={babEntry.bab} />);
    await screen.findByTestId("mc-quiz-session", undefined, { timeout: 4000 });
    const callsBeforeRefresh = readAnalyticsRawSnapshot.mock.calls.length;

    // The area has since fully recovered: a background refresh (e.g. the
    // learner switched apps and back) would no longer surface this group.
    readAnalyticsRawSnapshot.mockResolvedValue(emptySnapshot);
    document.dispatchEvent(new Event("visibilitychange"));

    // Confirm the refresh actually happened (not a vacuous assertion)...
    await waitFor(() =>
      expect(readAnalyticsRawSnapshot.mock.calls.length).toBeGreaterThan(
        callsBeforeRefresh,
      ),
    );
    // ...yet the live session stays mounted — the committed request is never
    // retroactively invalidated by a later background weakness reload.
    expect(screen.getByTestId("mc-quiz-session")).toBeInTheDocument();
    expect(screen.queryByText("This practice link isn't valid")).toBeNull();
  });

  it("never unmounts a live session when a background refresh fails outright (ARCH-003 regression)", async () => {
    render(<WeakDrillSession dimensionParam="bab" valueParam={babEntry.bab} />);
    await screen.findByTestId("mc-quiz-session", undefined, { timeout: 4000 });
    const callsBeforeRefresh = readAnalyticsRawSnapshot.mock.calls.length;

    // A background refresh (e.g. contention from another tab) fails outright.
    readAnalyticsRawSnapshot.mockRejectedValue(new Error("boom"));
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(readAnalyticsRawSnapshot.mock.calls.length).toBeGreaterThan(
        callsBeforeRefresh,
      ),
    );
    // The live session survives an analytics-only background failure — it
    // is never treated as fatal to an already-running quiz.
    expect(screen.getByTestId("mc-quiz-session")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("invalid drill request (§17, §27 'invalid request')", () => {
  it("shows a safe not-found state for an unrecognised dimension", async () => {
    render(
      <WeakDrillSession
        dimensionParam="not_a_real_dimension"
        valueParam="whatever"
      />,
    );
    expect(
      await screen.findByText("This practice link isn't valid"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mc-quiz-session")).toBeNull();
  });

  it("shows a safe not-found state for a value that is not a current weak group", async () => {
    render(
      <WeakDrillSession dimensionParam="bab" valueParam="not-a-real-bab-id" />,
    );
    expect(
      await screen.findByText("This practice link isn't valid"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mc-quiz-session")).toBeNull();
  });

  it("shows a safe not-found state when the params are missing", async () => {
    render(<WeakDrillSession dimensionParam={null} valueParam={null} />);
    expect(
      await screen.findByText("This practice link isn't valid"),
    ).toBeInTheDocument();
  });

  it("shows a safe not-found state when no evidence exists at all", async () => {
    readAnalyticsRawSnapshot.mockResolvedValue(emptySnapshot);
    render(<WeakDrillSession dimensionParam="bab" valueParam={babEntry.bab} />);
    expect(
      await screen.findByText("This practice link isn't valid"),
    ).toBeInTheDocument();
  });
});

describe("Study again after improvement (§19, §27 'empty-after-improvement')", () => {
  it("excludes a no-longer-weak component and shows the encouraging empty state", async () => {
    const user = userEvent.setup();
    render(<WeakDrillSession dimensionParam="bab" valueParam={babEntry.bab} />);

    const session = await screen.findByTestId("mc-quiz-session", undefined, {
      timeout: 4000,
    });
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

    // The area has since fully recovered: no attempts, no lapses, no
    // evidence at all — buildWeakDrillPlan must exclude it on rebuild.
    readAnalyticsRawSnapshot.mockResolvedValue(emptySnapshot);

    await user.click(screen.getByTestId("study-again"));
    expect(
      await screen.findByText(
        "Nice work — there's nothing left to practise in this area right now. Check Weak Areas for what's next.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mc-quiz-session")).toBeNull();
  });
});

describe("loading and error states (§27)", () => {
  it("announces loading while the weakness snapshot loads", () => {
    readAnalyticsRawSnapshot.mockImplementation(() => new Promise(() => {}));
    render(<WeakDrillSession dimensionParam="bab" valueParam={babEntry.bab} />);
    return waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Loading practice session" }),
      ).toBeInTheDocument(),
    );
  });

  it("shows a user-safe recoverable error and recovers on retry", async () => {
    readAnalyticsRawSnapshot.mockRejectedValueOnce(new Error("boom"));
    render(<WeakDrillSession dimensionParam="bab" valueParam={babEntry.bab} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("boom");

    await userEvent.click(
      screen.getByRole("button", { name: "Retry loading content" }),
    );
    await screen.findByTestId("mc-quiz-session", undefined, { timeout: 4000 });
  });
});
