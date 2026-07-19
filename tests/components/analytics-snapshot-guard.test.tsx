/**
 * The analytics load's local-date validation guard (Phase 12 §18, T6 fix
 * round): a clock whose formatted local date is malformed must fail INSIDE
 * the guarded load and surface the generic recoverable error — never reach
 * ActivityTrend's fail-loud date arithmetic mid-render, and never leak the
 * internal guard message.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Dashboard } from "@/components/dashboard/dashboard";
import type { ActiveContentState } from "@/components/content/use-active-content";

// An empty release is sufficient: the guard throws before any component
// derivation output is consumed.
const readyState: ActiveContentState = {
  status: "ready",
  entries: [],
  releaseId: "release-guard-test",
  contentVersion: "0",
  questionGeneratorVersion: "1",
  entryCount: 0,
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
      now: () => 1_784_000_000_000,
      timezone: "UTC",
      timezoneSource: "browser_detected" as const,
    })),
  };
});

// The ONE event-time implementation, forced to yield a malformed label —
// the exact corruption the guard exists to intercept.
vi.mock("@/modules/study-engine/attempts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/study-engine/attempts")>();
  return {
    ...original,
    computeEventTimeFields: () => ({
      occurredAtUtc: "not-a-timestamp",
      timezoneAtEvent: "UTC",
      utcOffsetMinutesAtEvent: 0,
      localDateAtEvent: "2026-13-40",
      timezoneSource: "browser_detected" as const,
    }),
  };
});

vi.mock("@/modules/analytics/persistence", () => ({
  readAnalyticsSnapshot: vi.fn(async () => ({
    components: [],
    attempts: [],
    events: [],
    dailyActivity: [],
  })),
  rebuildDailyActivity: vi.fn(),
}));

vi.mock("@/lib/preferences/use-session-defaults", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/preferences/use-session-defaults")
    >();
  return {
    ...original,
    useSessionDefaults: () => ({
      defaults: {
        questionCount: 20,
        optionCount: 4,
        newPerDay: 10,
        reviewsPerDay: 20,
      },
      loaded: true,
      update: vi.fn(),
    }),
  };
});

describe("analytics snapshot local-date guard", () => {
  it("a malformed effective local date degrades to the recoverable error", async () => {
    render(<Dashboard />);
    const alert = await screen.findByRole("alert");
    // The generic user-safe message — never the internal guard text, the
    // malformed label, or a render crash from ActivityTrend.
    expect(alert.textContent).toContain("Your study history is safe");
    expect(alert.textContent).not.toContain("invalid local date");
    expect(alert.textContent).not.toContain("2026-13-40");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
