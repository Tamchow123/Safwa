/**
 * Mixed "Start studying" session × learner-editable session defaults
 * (Phase 11, §4.4): the stored questions/session, new/day and reviews/day
 * values must all be honoured by the zero-config mixed plan.
 */
import { readFileSync } from "node:fs";

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { SessionDefaults } from "@/modules/profile/session-defaults";
import type { AttemptClock } from "@/modules/study-engine/attempts";
import type { SchedulingSnapshot } from "@/modules/study-session/persistence";

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

// Per-test effective clock; null = the real browser-detected fallback.
let mockedClock: AttemptClock | null = null;
vi.mock("@/modules/profile/timezone", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/timezone")>();
  return {
    ...original,
    readEffectiveClock: vi.fn(
      async () =>
        mockedClock ??
        original.resolveEffectiveClock(original.DEFAULT_TIMEZONE_PREFERENCE),
    ),
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

// Per-test stored session defaults (the §4.4 settings under test).
let mockedDefaults: SessionDefaults = {
  questionCount: 20,
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

// Per-test stored scheduling snapshot.
let mockedSnapshot: SchedulingSnapshot = {
  components: [],
  attempts: [],
  events: [],
};
vi.mock("@/modules/study-session/persistence", async (importActual) => {
  const actual =
    await importActual<typeof import("@/modules/study-session/persistence")>();
  return {
    ...actual,
    readSchedulingSnapshot: vi.fn(async () => mockedSnapshot),
    recordGradedAttempt: vi.fn(),
  };
});

import { MixedSession } from "@/components/study/mixed-session";

afterEach(() => {
  mockedDefaults = {
    questionCount: 20,
    optionCount: 4,
    newPerDay: 10,
    reviewsPerDay: 20,
  };
  mockedSnapshot = { components: [], attempts: [], events: [] };
  mockedClock = null;
});

async function waitForSession(): Promise<HTMLElement> {
  return waitFor(() => screen.getByTestId("mc-quiz-session"), {
    timeout: 4000,
  });
}

describe("MixedSession — session defaults consumption (§4.4)", () => {
  it("caps a fresh guest's session at the configured new-items/day", async () => {
    mockedDefaults = { ...mockedDefaults, newPerDay: 3, questionCount: 20 };
    render(<MixedSession />);
    await waitForSession();
    // Empty history: the plan is exactly the configured new-item allowance.
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
  });

  it("caps the session at the configured questions/session below the daily room", async () => {
    mockedDefaults = { ...mockedDefaults, newPerDay: 10, questionCount: 4 };
    render(<MixedSession />);
    await waitForSession();
    expect(screen.getByText("Question 1 of 4")).toBeInTheDocument();
  });

  it("honours reviews/day: a due review is excluded when the review target is zero", async () => {
    const dueKey = "entry:1:skill:root_identification";
    mockedSnapshot = {
      components: [
        {
          componentKey: dueKey,
          fsrs: {
            stability: 1,
            difficulty: 5,
            dueAtMs: Date.now() - 86_400_000,
            state: "review",
            reps: 1,
            lapses: 0,
            scheduledDays: 1,
            learningSteps: 0,
            lastReviewAtMs: Date.now() - 2 * 86_400_000,
          },
          learnerState: "learning",
        },
      ],
      attempts: [],
      events: [],
    };
    mockedDefaults = { ...mockedDefaults, newPerDay: 2, reviewsPerDay: 0 };
    render(<MixedSession />);
    const session = await waitForSession();
    // Review budget zero: the due root review is NOT planned; the session is
    // the two allowed new items (which always open with recognition).
    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
    expect(session).toHaveAttribute("data-skill-type", "meaning_recognition");
  });

  it("honours reviews/day: the due review leads when the target allows it", async () => {
    const dueKey = "entry:1:skill:root_identification";
    mockedSnapshot = {
      components: [
        {
          componentKey: dueKey,
          fsrs: {
            stability: 1,
            difficulty: 5,
            dueAtMs: Date.now() - 86_400_000,
            state: "review",
            reps: 1,
            lapses: 0,
            scheduledDays: 1,
            learningSteps: 0,
            lastReviewAtMs: Date.now() - 2 * 86_400_000,
          },
          learnerState: "learning",
        },
      ],
      attempts: [],
      events: [],
    };
    mockedDefaults = { ...mockedDefaults, newPerDay: 0, reviewsPerDay: 5 };
    render(<MixedSession />);
    const session = await waitForSession();
    // New budget zero, review budget open: the session is exactly the due
    // review.
    expect(screen.getByText("Question 1 of 1")).toBeInTheDocument();
    expect(session).toHaveAttribute("data-skill-type", "root_identification");
  });

  it("computes today's budget in the EFFECTIVE zone, not UTC (§10.5/§12)", async () => {
    // Frozen instant: 2026-07-18 20:00 UTC = 2026-07-19 05:00 Asia/Tokyo.
    // Two chain-root scheduling events dated Tokyo-today have consumed the
    // whole new budget; a UTC misread ("2026-07-18") would not count them
    // and would render a session of new items instead of the empty state.
    mockedClock = {
      now: () => Date.UTC(2026, 6, 18, 20, 0, 0),
      timezone: "Asia/Tokyo",
      timezoneSource: "user_setting",
    };
    mockedDefaults = { ...mockedDefaults, newPerDay: 2, reviewsPerDay: 0 };
    mockedSnapshot = {
      components: [],
      attempts: [],
      events: [
        {
          componentKey: "entry:1:skill:bab_identification",
          parentEventId: null,
          status: "scheduling",
          localDateAtEvent: "2026-07-19",
        },
        {
          componentKey: "entry:2:skill:bab_identification",
          parentEventId: null,
          status: "scheduling",
          localDateAtEvent: "2026-07-19",
        },
      ],
    };
    render(<MixedSession />);
    await waitFor(
      () =>
        expect(
          screen.getByText(/Nothing to study right now/),
        ).toBeInTheDocument(),
      { timeout: 4000 },
    );
  });
});
