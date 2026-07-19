/**
 * Recent-activity trend (Phase 12 §13, full-phase review FUNC-P101): the
 * "No activity yet" zero state is judged on the learner's FULL history —
 * a returning learner whose activity predates the visible window keeps
 * every zero bar represented with an honest window-scoped note, never a
 * false "never studied" message.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityTrend } from "@/components/analytics/activity-trend";
import type { DailyActivity } from "@/modules/analytics";

function row(localDate: string, attempts: number): DailyActivity {
  return { localDate, attempts, reviews: 0, newItems: 0, studyMs: 1000 };
}

describe("ActivityTrend", () => {
  it("shows the genuine zero state only when NO activity exists at all", () => {
    render(
      <ActivityTrend
        label="Attempts per day over the last 14 days"
        endDate="2026-07-19"
        days={14}
        activity={[]}
      />,
    );
    expect(screen.getByTestId("trend-empty")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-date]")).toHaveLength(0);
  });

  it("keeps zero bars represented when history predates the window", () => {
    const { container } = render(
      <ActivityTrend
        label="Attempts per day over the last 14 days"
        endDate="2026-07-19"
        days={14}
        activity={[row("2026-06-01", 3)]}
      />,
    );
    // NEVER "No activity yet" for a learner with real history.
    expect(screen.queryByTestId("trend-empty")).toBeNull();
    // All 14 zero-activity dates keep their represented bar slot (§13)…
    expect(container.querySelectorAll("[data-date]")).toHaveLength(14);
    expect(
      container.querySelectorAll('[data-date][data-attempts="0"]'),
    ).toHaveLength(14);
    // …and the note is honest and window-scoped.
    expect(screen.getByTestId("trend-window-empty")).toHaveTextContent(
      "No attempts in the last 14 days.",
    );
  });

  it("renders in-window values with no empty-state messaging", () => {
    const { container } = render(
      <ActivityTrend
        label="Attempts per day over the last 14 days"
        endDate="2026-07-19"
        days={14}
        activity={[row("2026-07-18", 5)]}
      />,
    );
    expect(screen.queryByTestId("trend-empty")).toBeNull();
    expect(screen.queryByTestId("trend-window-empty")).toBeNull();
    expect(container.querySelector('[data-date="2026-07-18"]')).toHaveAttribute(
      "data-attempts",
      "5",
    );
  });
});
