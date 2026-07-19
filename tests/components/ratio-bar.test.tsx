/**
 * Accessible ratio/track primitives (Phase 12 §7.9, §12; full-phase review
 * TEST-P103): the visual fill clamps at 100% for exceeded targets while the
 * accessible value text keeps the real counts, and a legitimately empty
 * dimension renders as unavailable, never NaN.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProgressTrack, RatioBar } from "@/components/analytics/ratio-bar";

describe("ProgressTrack", () => {
  it("clamps the VISUAL fill at 100% while the value text keeps the overage", () => {
    render(
      <ProgressTrack
        ariaLabel="New items today"
        max={10}
        now={10}
        valueText="12 of 10"
        percent={120}
      />,
    );
    const track = screen.getByRole("progressbar", { name: "New items today" });
    expect(track).toHaveAttribute("aria-valuetext", "12 of 10");
    const fill = track.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("renders an uncapped percent as its real width below 100", () => {
    render(
      <ProgressTrack
        ariaLabel="Reviews today"
        max={20}
        now={5}
        valueText="5 of 20"
        percent={25}
      />,
    );
    const fill = screen.getByRole("progressbar", { name: "Reviews today" })
      .firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("25%");
  });
});

describe("RatioBar", () => {
  it("renders a zero-denominator ratio as unavailable, never NaN", () => {
    render(
      <RatioBar
        label="Empty dimension"
        accessibleLabel="Empty dimension"
        ratio={{ numerator: 0, denominator: 0 }}
      />,
    );
    expect(screen.getByText("Not available yet.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(document.body.textContent).not.toContain("NaN");
  });
});
