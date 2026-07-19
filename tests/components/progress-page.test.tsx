/**
 * Detailed Progress route (Phase 12 §17, §25; Phase 13 §15): exact
 * numerator/denominator text against the real release denominators (§21.1),
 * per-skill and per-form completion, restrained bāb/verb-type sections
 * labelled by Arabic display pairs from the release, streaks, the longer
 * activity summary, word states, loading/error states, no raw component
 * keys, and a concise integrated Weak Areas section (top priorities + link
 * to the full page — never the complete ranked/tabbed analysis).
 */
import { readFileSync } from "node:fs";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProgressPage from "@/app/(shell)/progress/page";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type {
  AnalyticsPersistenceSnapshot,
  AnalyticsRawRead,
} from "@/modules/analytics/persistence";
import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import { deriveAllComponents } from "@/modules/study-engine/components";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const derived = deriveAllComponents(built.learner.entries);

/** Frozen instant: 2026-07-19 12:00 UTC (the effective zone is UTC below). */
const NOW_MS = Date.UTC(2026, 6, 19, 12, 0, 0);
const TODAY = "2026-07-19";

const readyState: ActiveContentState = {
  status: "ready",
  entries: built.learner.entries,
  releaseId: built.releaseId,
  contentVersion: built.learner.content_version,
  questionGeneratorVersion: built.learner.question_generator_version,
  entryCount: built.learner.entries.length,
  source: "cache",
};

let activeContent: ActiveContentState;
vi.mock("@/components/content/use-active-content", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/content/use-active-content")
    >();
  return {
    ...original,
    useActiveContent: () => ({ state: activeContent, retry: vi.fn() }),
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

const readAnalyticsSnapshot =
  vi.fn<(db: unknown, now: number) => Promise<AnalyticsPersistenceSnapshot>>();
const readAnalyticsRawSnapshot =
  vi.fn<(db: unknown) => Promise<AnalyticsRawRead>>();
vi.mock("@/modules/analytics/persistence", () => ({
  readAnalyticsSnapshot: (db: unknown, now: number) =>
    readAnalyticsSnapshot(db, now),
  readAnalyticsRawSnapshot: (db: unknown) => readAnalyticsRawSnapshot(db),
  rebuildDailyActivity: vi.fn(),
}));

/** A usable FSRS card due well in the future (keeps mastered mastered). */
const futureCard: SchedulerCard = {
  stability: 30,
  difficulty: 5,
  dueAtMs: NOW_MS + 30 * 86_400_000,
  state: "review",
  reps: 3,
  lapses: 0,
  scheduledDays: 30,
  learningSteps: 0,
  lastReviewAtMs: NOW_MS - 86_400_000,
};

const masteredEntry = built.learner.entries[0];
const masteredComponents = derived.filter(
  (component) => component.entryId === masteredEntry.id && component.essential,
);

const seededSnapshot: AnalyticsPersistenceSnapshot = {
  components: masteredComponents.map((component) => ({
    componentKey: component.key,
    learnerState: "mastered" as const,
    fsrs: futureCard,
  })),
  attempts: [],
  events: [],
  dailyActivity: [
    {
      localDate: "2026-07-18",
      attempts: 2,
      reviews: 1,
      newItems: 1,
      studyMs: 30_000,
    },
    { localDate: TODAY, attempts: 5, reviews: 2, newItems: 3, studyMs: 60_000 },
  ],
};

beforeEach(() => {
  activeContent = readyState;
  readAnalyticsSnapshot.mockReset();
  readAnalyticsSnapshot.mockResolvedValue(seededSnapshot);
  readAnalyticsRawSnapshot.mockReset();
  // Default: no attempts at all — the Weak Areas section shows its
  // no-evidence state unless a test seeds otherwise.
  readAnalyticsRawSnapshot.mockResolvedValue({
    components: seededSnapshot.components,
    attempts: seededSnapshot.attempts,
    events: seededSnapshot.events,
  });
});

describe("progress overview and denominators (§17, §21.1)", () => {
  it("renders the exact release denominators for every dimension", async () => {
    render(<ProgressPage />);
    const components = await screen.findByRole("progressbar", {
      name: "Components mastered",
    });
    expect(components).toHaveAttribute("aria-valuemax", "6793");
    expect(components).toHaveAttribute(
      "aria-valuenow",
      String(masteredComponents.length),
    );
    expect(components).toHaveAttribute(
      "aria-valuetext",
      `${masteredComponents.length} of 6,793`,
    );

    const perSkillMax: Record<string, string> = {
      "Meaning recognition (Arabic → English)": "2716",
      "Meaning recall (English → Arabic)": "2716",
      "Bāb identification": "455",
      "Root identification": "453",
      "Verb type identification": "453",
    };
    for (const [name, max] of Object.entries(perSkillMax)) {
      expect(screen.getByRole("progressbar", { name })).toHaveAttribute(
        "aria-valuemax",
        max,
      );
    }

    const perFormMax: Record<string, string> = {
      "Past (māḍī)": "910",
      "Present (muḍāriʿ)": "908",
      "Verbal noun (maṣdar)": "890",
      "Active participle (ism al-fāʿil)": "908",
      "Command (amr)": "908",
      "Prohibition (nahī)": "908",
    };
    for (const [name, max] of Object.entries(perFormMax)) {
      expect(screen.getByRole("progressbar", { name })).toHaveAttribute(
        "aria-valuemax",
        max,
      );
    }
  });

  it("shows all four word states including Started", async () => {
    render(<ProgressPage />);
    expect(await screen.findByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.getByText("Learning")).toBeInTheDocument();
    expect(screen.getByText("Mastered")).toBeInTheDocument();
    // One fully mastered entry: 454 not started, 1 started, 1 mastered.
    expect(screen.getByText("454")).toBeInTheDocument();
  });

  it("renders exactly one h1 (the page header)", async () => {
    render(<ProgressPage />);
    await screen.findByText("Started");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Progress");
  });
});

describe("bāb and verb-type sections (§17, hard rule 5)", () => {
  it("labels every bāb bar with its Arabic pair from the release", async () => {
    render(<ProgressPage />);
    await screen.findByText("By bāb");
    // The six bāb display pairs, read programmatically (never hand-typed).
    const babArabic = [
      ...new Set(built.learner.entries.map((entry) => entry.bab_arabic)),
    ];
    expect(babArabic).toHaveLength(6);
    for (const arabic of babArabic) {
      expect(
        screen.getByRole("progressbar", { name: arabic }),
      ).toBeInTheDocument();
    }
  });

  it("only verb-type-eligible entries produce verb-type bars", async () => {
    render(<ProgressPage />);
    await screen.findByText("By verb type");
    const eligibleArabic = [
      ...new Set(
        built.learner.entries
          .filter((entry) => entry.quiz_eligibility.verb_type)
          .map((entry) => entry.verb_type_arabic),
      ),
    ];
    for (const arabic of eligibleArabic) {
      expect(
        screen.getByRole("progressbar", { name: arabic }),
      ).toBeInTheDocument();
    }
    // The two unverified entries (369/372) never classify their entries: the
    // eligible denominators sum to 453, not 455.
    const verbTypeBars = eligibleArabic.map((arabic) =>
      screen.getByRole("progressbar", { name: arabic }),
    );
    const summedDenominators = verbTypeBars.reduce(
      (sum, bar) => sum + Number(bar.getAttribute("aria-valuemax")),
      0,
    );
    const eligibleEssentialTotal = derived.filter(
      (component) =>
        component.essential &&
        built.learner.entries.find((entry) => entry.id === component.entryId)
          ?.quiz_eligibility.verb_type,
    ).length;
    expect(summedDenominators).toBe(eligibleEssentialTotal);
  });
});

describe("streaks, activity and navigation (§17)", () => {
  it("shows current and longest streaks and the longer trend", async () => {
    render(<ProgressPage />);
    expect(await screen.findByText("Current streak")).toBeInTheDocument();
    expect(screen.getByText("Longest streak")).toBeInTheDocument();
    expect(screen.getAllByText("2 days")).toHaveLength(2);
    expect(
      screen.getByText("Attempts per day over the last 30 days"),
    ).toBeInTheDocument();
  });

  it("links to Study", async () => {
    render(<ProgressPage />);
    expect(
      await screen.findByRole("link", { name: "Go to Study" }),
    ).toHaveAttribute("href", "/study");
  });

  it("never renders a raw component key", async () => {
    render(<ProgressPage />);
    await screen.findByText("Started");
    expect(document.body.textContent).not.toContain(masteredComponents[0].key);
  });
});

describe("integrated Weak Areas section (Phase 13 §15)", () => {
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

  function isoAt(daysAgo: number): string {
    return new Date(Date.UTC(2026, 6, 19 - daysAgo, 10, 0, 0)).toISOString();
  }
  function localDate(daysAgo: number): string {
    return isoAt(daysAgo).slice(0, 10);
  }

  const weakRawSnapshot: AnalyticsRawRead = {
    components: [
      {
        componentKey: babComponent.key,
        learnerState: "learning",
        fsrs: {
          stability: 5,
          difficulty: 6,
          dueAtMs: NOW_MS + 5 * 86_400_000,
          state: "review",
          reps: 3,
          lapses: 1,
          scheduledDays: 5,
          learningSteps: 0,
          lastReviewAtMs: NOW_MS - 2 * 86_400_000,
        },
      },
    ],
    attempts: [0, 1, 2, 3, 4].map((daysAgo, i) => ({
      id: `weak-attempt-${daysAgo}`,
      componentKey: babComponent.key,
      localDateAtEvent: localDate(daysAgo),
      responseTimeMs: 1_000,
      occurredAtUtc: isoAt(daysAgo),
      entryId: babEntry.id,
      skillType: "bab_identification" as const,
      direction: null,
      sourceField: null,
      promptField: "madi" as const,
      isFirstAttempt: true,
      isReinforcement: false,
      isCorrect: i % 2 === 0,
    })),
    events: [],
  };

  it("shows the no-evidence state by default", async () => {
    render(<ProgressPage />);
    await screen.findByText("Started");
    expect(await screen.findByText("Weak areas")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Study a few items to discover which areas need more practice.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "See all weak areas" }),
    ).toHaveAttribute("href", "/progress/weak-areas");
  });

  it("shows the top priorities and links to the full page", async () => {
    readAnalyticsRawSnapshot.mockResolvedValue(weakRawSnapshot);
    render(<ProgressPage />);
    await screen.findByText("Weak areas");
    expect(await screen.findByText(babEntry.bab_arabic)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "See all weak areas" }),
    ).toHaveAttribute("href", "/progress/weak-areas");
    // Never a raw component key, even in the weak-area cards.
    expect(document.body.textContent).not.toContain(babComponent.key);
  });

  it("shows a per-section loading state without blocking the rest of the page", async () => {
    readAnalyticsRawSnapshot.mockImplementation(() => new Promise(() => {}));
    render(<ProgressPage />);
    // The exact-ratio content above it renders normally...
    await screen.findByText("Started");
    // ...while only the Weak Areas section shows its own loading state.
    expect(
      screen.getByRole("status", { name: "Loading weak areas" }),
    ).toBeInTheDocument();
  });

  it("shows a per-section recoverable error without blocking the rest of the page", async () => {
    readAnalyticsRawSnapshot.mockRejectedValue(new Error("boom"));
    render(<ProgressPage />);
    await screen.findByText("Started");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("boom");
  });
});

describe("progress loading and error states (§18)", () => {
  it("announces loading while the snapshot loads", () => {
    readAnalyticsSnapshot.mockImplementation(() => new Promise(() => {}));
    render(<ProgressPage />);
    expect(
      screen.getByRole("status", { name: "Loading progress" }),
    ).toBeInTheDocument();
  });

  it("shows a user-safe recoverable error and recovers on retry", async () => {
    readAnalyticsSnapshot.mockRejectedValueOnce(new Error("boom"));
    render(<ProgressPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("please retry");
    expect(alert.textContent).not.toContain("boom");

    // The page's own retry wiring must actually reload — not just render
    // a button (the next read resolves with the seeded snapshot).
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByText("Started")).toBeInTheDocument(),
    );
  });

  it("shows the loading state while content itself is loading", () => {
    activeContent = { status: "loading" };
    render(<ProgressPage />);
    expect(
      screen.getByRole("status", { name: "Loading progress" }),
    ).toBeInTheDocument();
    expect(readAnalyticsSnapshot).not.toHaveBeenCalled();
  });

  it("passes the content loader's own user-safe error message through", async () => {
    activeContent = {
      status: "error",
      message: "The downloaded content failed verification. Please retry.",
    };
    render(<ProgressPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The downloaded content failed verification. Please retry.",
    );
    expect(readAnalyticsSnapshot).not.toHaveBeenCalled();
  });
});
