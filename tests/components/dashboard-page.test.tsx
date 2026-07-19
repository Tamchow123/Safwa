/**
 * Dashboard route (Phase 12 §16, §25): honest zero state, seeded progress
 * with exact ratios, today's streak/study-time/due counts, daily-target
 * rendering (real counts, zero-target off state), the 14-day trend's
 * programmatic dates and values, loading/error/retry states, accessible
 * progress attributes, and no raw component keys in the rendered page.
 */
import { readFileSync } from "node:fs";

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DashboardPage from "@/app/(shell)/page";
import { SNAPSHOT_WATCHDOG_MS } from "@/components/analytics/use-analytics-snapshot";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { AnalyticsPersistenceSnapshot } from "@/modules/analytics/persistence";
import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import {
  DEFAULT_SESSION_DEFAULTS,
  type SessionDefaults,
} from "@/modules/profile/session-defaults";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import { deriveAllComponents } from "@/modules/study-engine/components";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const derived = deriveAllComponents(built.learner.entries);

/** Frozen instant: 2026-07-19 12:00 UTC (the effective zone is UTC below). */
const NOW_MS = Date.UTC(2026, 6, 19, 12, 0, 0);
const TODAY = "2026-07-19";
const YESTERDAY = "2026-07-18";

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

// A deterministic effective clock (UTC) so "today" is stable in every zone.
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

let sessionDefaults: SessionDefaults;
vi.mock("@/lib/preferences/use-session-defaults", () => ({
  useSessionDefaults: () => ({
    defaults: sessionDefaults,
    loaded: true,
    update: vi.fn(),
  }),
}));

const emptySnapshot: AnalyticsPersistenceSnapshot = {
  components: [],
  attempts: [],
  events: [],
  dailyActivity: [],
};

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

/** Entry 1 fully mastered; one entry-2 essential learning and due now. */
const masteredEntry = built.learner.entries[0];
const learningEntry = built.learner.entries[1];
const masteredComponents = derived.filter(
  (component) => component.entryId === masteredEntry.id && component.essential,
);
const dueComponent = derived.find(
  (component) => component.entryId === learningEntry.id && component.essential,
)!;

const seededSnapshot: AnalyticsPersistenceSnapshot = {
  components: [
    ...masteredComponents.map((component) => ({
      componentKey: component.key,
      learnerState: "mastered" as const,
      fsrs: futureCard,
    })),
    {
      componentKey: dueComponent.key,
      learnerState: "learning" as const,
      fsrs: {
        ...futureCard,
        state: "learning" as const,
        dueAtMs: NOW_MS - 1000,
      },
    },
  ],
  attempts: [],
  events: [],
  dailyActivity: [
    {
      localDate: YESTERDAY,
      attempts: 2,
      reviews: 1,
      newItems: 1,
      studyMs: 30_000,
    },
    {
      localDate: TODAY,
      attempts: 5,
      reviews: 2,
      newItems: 3,
      studyMs: 125_000,
    },
  ],
};

beforeEach(() => {
  activeContent = readyState;
  sessionDefaults = { ...DEFAULT_SESSION_DEFAULTS };
  readAnalyticsSnapshot.mockReset();
  readAnalyticsSnapshot.mockResolvedValue(emptySnapshot);
});

describe("dashboard zero state (§16, §18)", () => {
  it("shows honest zeros, no fake data, and a study action", async () => {
    render(<DashboardPage />);
    expect(await screen.findAllByText(/0 of 455/)).not.toHaveLength(0);
    expect(screen.getByText("0 days")).toBeInTheDocument();
    expect(screen.getByText("0 min")).toBeInTheDocument();
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument();
    expect(screen.getByText(/haven't studied yet/)).toBeInTheDocument();
    const study = screen.getByRole("link", { name: "Start studying" });
    expect(study).toHaveAttribute("href", "/study");
    expect(
      screen.getByRole("link", { name: "View detailed progress" }),
    ).toHaveAttribute("href", "/progress");
  });

  it("renders exactly one h1 (the page header)", async () => {
    render(<DashboardPage />);
    await screen.findAllByText(/0 of 455/);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Dashboard");
  });
});

describe("dashboard seeded progress (§16, §25)", () => {
  beforeEach(() => {
    readAnalyticsSnapshot.mockResolvedValue(seededSnapshot);
  });

  it("shows the exact overall ratio and word-state counts", async () => {
    render(<DashboardPage />);
    expect(await screen.findAllByText(/1 of 455/)).not.toHaveLength(0);
    // 1 mastered + 1 learning ⇒ 453 not started.
    expect(screen.getByText("453")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Words mastered" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "455");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
  });

  it("shows today's streak, study time and due-review count", async () => {
    render(<DashboardPage />);
    expect(await screen.findByText("2 days")).toBeInTheDocument();
    expect(screen.getByText("2 min")).toBeInTheDocument();
    // EXACTLY one: only the past-due learning card counts — the mastered
    // future-due cards do not (a regression to 10/11/21 must fail here).
    expect(screen.getByTestId("due-today-count")).toHaveTextContent(/^1$/);
    // The Today values update on visibility refresh, so they live in a
    // restrained polite live region (§19).
    expect(screen.getByText("Current streak").closest("dl")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("renders daily targets with real counts against the defaults", async () => {
    render(<DashboardPage />);
    expect(await screen.findByText("3 of 10")).toBeInTheDocument();
    expect(screen.getByText("2 of 20")).toBeInTheDocument();
    const newBar = screen.getByRole("progressbar", { name: "New items today" });
    expect(newBar).toHaveAttribute("aria-valuemax", "10");
    expect(newBar).toHaveAttribute("aria-valuenow", "3");
  });

  it("renders a zero target as off — never a division by zero", async () => {
    sessionDefaults = { ...DEFAULT_SESSION_DEFAULTS, newPerDay: 0 };
    render(<DashboardPage />);
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(
      screen.queryByRole("progressbar", { name: "New items today" }),
    ).toBeNull();
    // The reviews target renders normally alongside it.
    expect(screen.getByText("2 of 20")).toBeInTheDocument();
  });

  it("the trend carries programmatic ISO dates and values plus an SR table", async () => {
    const { container } = render(<DashboardPage />);
    await screen.findAllByText(/1 of 455/);
    const todayBar = container.querySelector(`[data-date="${TODAY}"]`);
    expect(todayBar).not.toBeNull();
    expect(todayBar).toHaveAttribute("data-attempts", "5");
    // Zero-activity dates keep their slot; the window is EXACTLY 14 bars.
    expect(container.querySelector('[data-date="2026-07-06"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-date]")).toHaveLength(14);
    // Values reach assistive technology through the table, not tooltips.
    expect(
      screen.getByText("Attempts per day over the last 14 days"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("rowheader", { name: "Jul 19" }),
    ).toBeInTheDocument();
  });

  it("never renders a raw component key", async () => {
    render(<DashboardPage />);
    await screen.findAllByText(/1 of 455/);
    expect(document.body.textContent).not.toContain(masteredComponents[0].key);
  });
});

describe("visibility refresh (§14.4)", () => {
  const refreshedSnapshot: AnalyticsPersistenceSnapshot = {
    ...seededSnapshot,
    dailyActivity: [
      ...seededSnapshot.dailyActivity.slice(0, 1),
      {
        localDate: TODAY,
        attempts: 9,
        reviews: 4,
        newItems: 5,
        studyMs: 300_000,
      },
    ],
  };

  it("re-reads the snapshot on visibility regain, keeping the old view mounted", async () => {
    readAnalyticsSnapshot.mockResolvedValue(seededSnapshot);
    render(<DashboardPage />);
    expect(await screen.findByText("2 min")).toBeInTheDocument();

    readAnalyticsSnapshot.mockResolvedValue(refreshedSnapshot);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The previous ready view stays mounted — no loading skeleton flash.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("2 min")).toBeInTheDocument();
    // The fresh numbers replace it once the re-read resolves.
    expect(await screen.findByText("5 min")).toBeInTheDocument();
    expect(screen.getByText("5 of 10")).toBeInTheDocument();
  });

  it("a failed refresh surfaces the recoverable error state", async () => {
    readAnalyticsSnapshot.mockResolvedValue(seededSnapshot);
    render(<DashboardPage />);
    await screen.findByText("2 min");

    readAnalyticsSnapshot.mockRejectedValueOnce(new Error("refresh boom"));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("please retry");
    expect(alert.textContent).not.toContain("refresh boom");
  });

  it("a burst of visibility events coalesces to a single re-read", async () => {
    readAnalyticsSnapshot.mockResolvedValue(seededSnapshot);
    render(<DashboardPage />);
    await screen.findByText("2 min");
    expect(readAnalyticsSnapshot).toHaveBeenCalledTimes(1);

    // The refresh load stays pending while further events arrive.
    let resolveRefresh: (value: AnalyticsPersistenceSnapshot) => void;
    readAnalyticsSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(readAnalyticsSnapshot).toHaveBeenCalledTimes(2));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Still exactly one in-flight re-read — the burst coalesced.
    expect(readAnalyticsSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveRefresh!(refreshedSnapshot);
    });
    expect(await screen.findByText("5 min")).toBeInTheDocument();
  });
});

describe("content loading and error passthrough (§18)", () => {
  it("shows the loading state while content itself is loading", () => {
    activeContent = { status: "loading" };
    render(<DashboardPage />);
    expect(
      screen.getByRole("status", { name: "Loading dashboard" }),
    ).toBeInTheDocument();
    // No analytics read can happen without the release.
    expect(readAnalyticsSnapshot).not.toHaveBeenCalled();
  });

  it("passes the content loader's own user-safe error message through", async () => {
    activeContent = {
      status: "error",
      message: "No content is available. Check your connection and retry.",
    };
    render(<DashboardPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "No content is available. Check your connection and retry.",
    );
    expect(readAnalyticsSnapshot).not.toHaveBeenCalled();
  });
});

describe("dashboard loading and error states (§18)", () => {
  it("announces a stable loading state while the snapshot loads", () => {
    readAnalyticsSnapshot.mockImplementation(() => new Promise(() => {}));
    render(<DashboardPage />);
    expect(
      screen.getByRole("status", { name: "Loading dashboard" }),
    ).toBeInTheDocument();
  });

  it("shows a user-safe recoverable error and recovers on retry", async () => {
    readAnalyticsSnapshot.mockRejectedValueOnce(
      new Error("Dexie internal: object store daily_activity"),
    );
    readAnalyticsSnapshot.mockResolvedValue(emptySnapshot);
    render(<DashboardPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("please retry");
    // Internals never leak into the learner-facing message.
    expect(alert.textContent).not.toContain("Dexie");
    expect(alert.textContent).not.toContain("daily_activity");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getAllByText(/0 of 455/)).not.toHaveLength(0),
    );
  });

  it("fails over to a recoverable error when the load never settles", async () => {
    // Guards the Dexie-upgrade-blocked scenario: a hung open must not
    // strand the page on the skeleton forever (watchdog, §18).
    vi.useFakeTimers();
    try {
      readAnalyticsSnapshot.mockImplementation(() => new Promise(() => {}));
      render(<DashboardPage />);
      expect(
        screen.getByRole("status", { name: "Loading dashboard" }),
      ).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SNAPSHOT_WATCHDOG_MS + 1);
      });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("taking longer than expected");
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
