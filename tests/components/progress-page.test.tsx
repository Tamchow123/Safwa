/**
 * Detailed Progress route (Phase 12 §17, §25): exact numerator/denominator
 * text against the real release denominators (§21.1), per-skill and per-form
 * completion, restrained bāb/verb-type sections labelled by Arabic display
 * pairs from the release, streaks, the longer activity summary, word states,
 * loading/error states, and no weak-area output or raw component keys.
 */
import { readFileSync } from "node:fs";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProgressPage from "@/app/(shell)/progress/page";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { AnalyticsPersistenceSnapshot } from "@/modules/analytics/persistence";
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
vi.mock("@/modules/analytics/persistence", () => ({
  readAnalyticsSnapshot: (db: unknown, now: number) =>
    readAnalyticsSnapshot(db, now),
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

  it("links to Study and never fakes weak-area output", async () => {
    render(<ProgressPage />);
    expect(
      await screen.findByRole("link", { name: "Go to Study" }),
    ).toHaveAttribute("href", "/study");
    expect(screen.queryByText(/weak/i)).toBeNull();
  });

  it("never renders a raw component key", async () => {
    render(<ProgressPage />);
    await screen.findByText("Started");
    expect(document.body.textContent).not.toContain(masteredComponents[0].key);
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
