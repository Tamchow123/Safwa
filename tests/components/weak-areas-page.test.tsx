/**
 * Weak Areas page (Phase 13 §15-16, §27): no-evidence vs no-current-weakness
 * empty states, the ranked overview, dimension switching, exact accuracy/
 * lapse/last-practised text, priority labels, bāb/verb-type Arabic
 * rendering, shared form/direction/skill/state labels, the drill action,
 * loading/error states, and supportive/accessible/raw-id-free copy.
 *
 * Every fixture attempt is driven through the REAL T1-T3 weakness pipeline
 * (`loadWeaknessView`) via a seeded `readAnalyticsRawSnapshot` — never a
 * hand-typed expected score — and Arabic values are always read
 * programmatically from the real release (`built.learner.entries`), never
 * hand-typed (CLAUDE.md hard rule 3).
 */
import { readFileSync } from "node:fs";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WeakAreasPage from "@/app/(shell)/progress/weak-areas/page";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { AnalyticsAttempt } from "@/modules/analytics/activity";
import type { AnalyticsRawRead } from "@/modules/analytics/persistence";
import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import { deriveAllComponents } from "@/modules/study-engine/components";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const derived = deriveAllComponents(built.learner.entries);

/** Frozen instant: 2026-07-19 12:00 UTC (the effective zone is UTC below). */
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

function isoAt(daysAgo: number, hourOfDay = 12): string {
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

// A bāb-eligible entry with a derivable bāb-identification component.
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

// A distinct entry with a DIFFERENT bāb (so its evidence never blends into
// babEntry's "bab" dimension group) and an eligible mudari meaning-
// recognition (Ar->En) translation component, for the direction/skill/form
// fixtures.
const translationEntry = built.learner.entries.find(
  (e) =>
    e.id !== babEntry.id &&
    e.bab !== babEntry.bab &&
    derived.some(
      (c) =>
        c.entryId === e.id &&
        c.skillType === "meaning_recognition" &&
        c.direction === "arabic_to_english" &&
        c.sourceField === "mudari",
    ),
)!;
const translationComponent = derived.find(
  (c) =>
    c.entryId === translationEntry.id &&
    c.skillType === "meaning_recognition" &&
    c.direction === "arabic_to_english" &&
    c.sourceField === "mudari",
)!;

let attemptCounter = 0;
function attempt(
  componentKey: string,
  entryId: number,
  overrides: Partial<AnalyticsAttempt>,
): AnalyticsAttempt {
  attemptCounter += 1;
  return {
    id: `attempt-${attemptCounter}`,
    componentKey,
    localDateAtEvent: localDate(0),
    responseTimeMs: 1_000,
    occurredAtUtc: isoAt(0),
    entryId,
    skillType: "bab_identification",
    direction: null,
    sourceField: null,
    promptField: null,
    isFirstAttempt: true,
    isReinforcement: false,
    isCorrect: true,
    ...overrides,
  };
}

/**
 * Default fixture: the bāb-identification component has 5 first attempts
 * (3 incorrect, 2 correct — 40% recent accuracy), a most-recent attempt
 * today (incorrect), and 1 FSRS lapse; the translation component has 4
 * first attempts, all incorrect, no lapses. Both qualify as weak (real
 * `computeComponentWeakness`, not a hand-typed score).
 */
function defaultSnapshot(): AnalyticsRawRead {
  const attempts: AnalyticsAttempt[] = [
    attempt(babComponent.key, babEntry.id, {
      occurredAtUtc: isoAt(0, 10),
      localDateAtEvent: localDate(0),
      isCorrect: false,
      promptField: "madi",
    }),
    attempt(babComponent.key, babEntry.id, {
      occurredAtUtc: isoAt(1),
      localDateAtEvent: localDate(1),
      isCorrect: true,
      promptField: "madi",
    }),
    attempt(babComponent.key, babEntry.id, {
      occurredAtUtc: isoAt(2),
      localDateAtEvent: localDate(2),
      isCorrect: false,
      promptField: "madi",
    }),
    attempt(babComponent.key, babEntry.id, {
      occurredAtUtc: isoAt(3),
      localDateAtEvent: localDate(3),
      isCorrect: true,
      promptField: "madi",
    }),
    attempt(babComponent.key, babEntry.id, {
      occurredAtUtc: isoAt(4),
      localDateAtEvent: localDate(4),
      isCorrect: false,
      promptField: "madi",
    }),
    ...[0, 1, 2, 3].map((daysAgo) =>
      attempt(translationComponent.key, translationEntry.id, {
        occurredAtUtc: isoAt(daysAgo),
        localDateAtEvent: localDate(daysAgo),
        isCorrect: false,
        skillType: "meaning_recognition",
        direction: "arabic_to_english",
        sourceField: "mudari",
      }),
    ),
  ];
  return {
    components: [
      {
        componentKey: babComponent.key,
        learnerState: "learning",
        fsrs: usableCard(1),
      },
      {
        componentKey: translationComponent.key,
        learnerState: "learning",
        fsrs: usableCard(0),
      },
    ],
    attempts,
    events: [],
  };
}

beforeEach(() => {
  attemptCounter = 0;
  activeContent = readyState;
  readAnalyticsRawSnapshot.mockReset();
  readAnalyticsRawSnapshot.mockResolvedValue(defaultSnapshot());
});

describe("no-evidence state (§15, §27)", () => {
  it("shows the no-study-evidence message and a Study action for a new guest", async () => {
    readAnalyticsRawSnapshot.mockResolvedValue(emptySnapshot);
    render(<WeakAreasPage />);
    expect(
      await screen.findByText(
        "Study a few items to discover which areas need more practice.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Start studying" }),
    ).toHaveAttribute("href", "/study");
    // Never shown as an error.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("no-current-weakness state (§15, §27)", () => {
  it("distinguishes 'evidence exists but nothing qualifies as weak' from no-evidence", async () => {
    readAnalyticsRawSnapshot.mockResolvedValue({
      components: [],
      attempts: [
        attempt(babComponent.key, babEntry.id, {
          occurredAtUtc: isoAt(0),
          localDateAtEvent: localDate(0),
          isCorrect: true,
          promptField: "madi",
        }),
      ],
      events: [],
    });
    render(<WeakAreasPage />);
    expect(
      await screen.findAllByText("No clear weak areas right now."),
    ).not.toHaveLength(0);
    expect(
      screen.queryByText(
        "Study a few items to discover which areas need more practice.",
      ),
    ).toBeNull();
  });
});

describe("ranked overview (§14, §27)", () => {
  it("ranks a more-heavily-failed bāb above a less-failed one in the overview tab", async () => {
    const otherBabEntry = built.learner.entries.find(
      (e) =>
        e.quiz_eligibility.bab &&
        e.bab !== babEntry.bab &&
        derived.some(
          (c) => c.entryId === e.id && c.skillType === "bab_identification",
        ),
    )!;
    const otherBabComponent = derived.find(
      (c) =>
        c.entryId === otherBabEntry.id && c.skillType === "bab_identification",
    )!;

    readAnalyticsRawSnapshot.mockResolvedValue({
      components: [
        {
          componentKey: babComponent.key,
          learnerState: "learning",
          fsrs: usableCard(1),
        },
        {
          componentKey: otherBabComponent.key,
          learnerState: "learning",
          fsrs: usableCard(2),
        },
      ],
      attempts: [
        // Weaker: 3/5 incorrect.
        ...[0, 1, 2, 3, 4].map((daysAgo, i) =>
          attempt(babComponent.key, babEntry.id, {
            occurredAtUtc: isoAt(daysAgo, 10),
            localDateAtEvent: localDate(daysAgo),
            isCorrect: i % 2 === 0,
            promptField: "madi",
          }),
        ),
        // Much weaker: 5/5 incorrect, more lapses.
        ...[0, 1, 2, 3, 4].map((daysAgo) =>
          attempt(otherBabComponent.key, otherBabEntry.id, {
            occurredAtUtc: isoAt(daysAgo, 10),
            localDateAtEvent: localDate(daysAgo),
            isCorrect: false,
            promptField: "madi",
          }),
        ),
      ],
      events: [],
    });

    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Bāb" }));
    const region = await screen.findByRole("region", { name: "Bāb" });
    const articles = within(region).getAllByRole("article");
    expect(articles.length).toBe(2);
    const names = articles.map((el) => el.getAttribute("aria-label"));
    expect(names.indexOf(otherBabEntry.bab_arabic)).toBeLessThan(
      names.indexOf(babEntry.bab_arabic),
    );
  });
});

describe("dimension switching (§15, §27)", () => {
  it("switches the ranked list to the selected dimension only", async () => {
    render(<WeakAreasPage />);
    await screen.findByText("Top practice priorities");

    await userEvent.click(screen.getByRole("button", { name: "Direction" }));
    const directionRegion = await screen.findByRole("region", {
      name: "Direction",
    });
    expect(
      within(directionRegion).getByText("Arabic → English"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Bāb" }));
    const babRegion = await screen.findByRole("region", { name: "Bāb" });
    expect(
      within(babRegion).getByText(babEntry.bab_arabic),
    ).toBeInTheDocument();
    expect(within(babRegion).queryByText("Arabic → English")).toBeNull();
  });
});

describe("exact accuracy, lapse and last-practised text (§27)", () => {
  it("shows the exact windowed accuracy, lapse count and recency text", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Bāb" }));
    const region = await screen.findByRole("region", { name: "Bāb" });
    const card = within(region).getByRole("article", {
      name: babEntry.bab_arabic,
    });
    expect(within(card).getByText("40%")).toBeInTheDocument();
    expect(within(card).getByText("Review lapses")).toBeInTheDocument();
    expect(within(card).getByText("1")).toBeInTheDocument();
    expect(within(card).getByText("Practised today")).toBeInTheDocument();
  });
});

describe("priority labels (§16, §27)", () => {
  it("shows a High/Medium/Lower priority label, and calls heavy recent failure High", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Bāb" }));
    const region = await screen.findByRole("region", { name: "Bāb" });
    const card = within(region).getByRole("article", {
      name: babEntry.bab_arabic,
    });
    expect(within(card).getByText("High priority")).toBeInTheDocument();
  });
});

describe("bāb and verb-type Arabic rendering (hard rules 3 & 5, §27)", () => {
  it("labels the bāb group with its exact Arabic pair from the release", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Bāb" }));
    const region = await screen.findByRole("region", { name: "Bāb" });
    expect(within(region).getByText(babEntry.bab_arabic)).toBeInTheDocument();
    // Never a bāb number or internal id in learner-facing copy.
    expect(within(region).queryByText(babEntry.bab)).toBeNull();
  });
});

describe("shared form, direction, skill and state labels (§27)", () => {
  it("labels the form group with the shared form metadata label", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Form" }));
    const region = await screen.findByRole("region", { name: "Form" });
    expect(within(region).getByText("Present (muḍāriʿ)")).toBeInTheDocument();
  });

  it("labels the direction group", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Direction" }),
    );
    const region = await screen.findByRole("region", { name: "Direction" });
    expect(within(region).getByText("Arabic → English")).toBeInTheDocument();
  });

  it("labels the skill group", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Skill" }));
    const region = await screen.findByRole("region", { name: "Skill" });
    expect(within(region).getByText("Bāb identification")).toBeInTheDocument();
  });

  it("labels the state group", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "State" }));
    const region = await screen.findByRole("region", { name: "State" });
    expect(within(region).getByText("Learning")).toBeInTheDocument();
  });
});

describe("drill action (§15, §27)", () => {
  it("links to the exact-weak-set drill route with dimension and value params", async () => {
    render(<WeakAreasPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Bāb" }));
    const region = await screen.findByRole("region", { name: "Bāb" });
    const card = within(region).getByRole("article", {
      name: babEntry.bab_arabic,
    });
    expect(
      within(card).getByRole("link", { name: "Review this area" }),
    ).toHaveAttribute(
      "href",
      `/study/weak?dimension=bab&value=${encodeURIComponent(babEntry.bab)}`,
    );
  });
});

describe("no raw ids and supportive wording (§16, §27)", () => {
  it("never renders a raw component key or discouraging wording", async () => {
    render(<WeakAreasPage />);
    await screen.findByText("Top practice priorities");
    expect(document.body.textContent).not.toContain(babComponent.key);
    expect(document.body.textContent).not.toContain(translationComponent.key);
    for (const bad of ["Bad at", "Failed", "Worst", "Poor learner"]) {
      expect(document.body.textContent).not.toContain(bad);
    }
  });
});

describe("accessible semantics (§27)", () => {
  it("renders exactly one h1 and h2 section headings", async () => {
    render(<WeakAreasPage />);
    await screen.findByText("Top practice priorities");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Weak areas");
    expect(
      screen.getAllByRole("heading", { level: 2 }).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("links back to Progress", async () => {
    render(<WeakAreasPage />);
    expect(
      await screen.findByRole("link", { name: "Back to Progress" }),
    ).toHaveAttribute("href", "/progress");
  });
});

describe("loading and error states (§18, §27)", () => {
  it("announces loading while the snapshot loads", () => {
    readAnalyticsRawSnapshot.mockImplementation(() => new Promise(() => {}));
    render(<WeakAreasPage />);
    expect(
      screen.getByRole("status", { name: "Loading weak areas" }),
    ).toBeInTheDocument();
  });

  it("shows a user-safe recoverable error and recovers on retry", async () => {
    readAnalyticsRawSnapshot.mockRejectedValueOnce(new Error("boom"));
    render(<WeakAreasPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("please retry");
    expect(alert.textContent).not.toContain("boom");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByText("Top practice priorities")).toBeInTheDocument(),
    );
  });
});
