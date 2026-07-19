/**
 * Study-duration formatting (Phase 12 §16/§25): honest small values, minute
 * rounding, hour/minute composition, and safe handling of invalid input.
 */
import { describe, expect, it } from "vitest";

import { formatStudyDuration } from "@/lib/format-duration";

describe("formatStudyDuration", () => {
  it("renders zero and invalid input as 0 min", () => {
    expect(formatStudyDuration(0)).toBe("0 min");
    expect(formatStudyDuration(-5000)).toBe("0 min");
    expect(formatStudyDuration(Number.NaN)).toBe("0 min");
    expect(formatStudyDuration(Number.POSITIVE_INFINITY)).toBe("0 min");
  });

  it("never hides real sub-minute effort behind 0 min", () => {
    expect(formatStudyDuration(1)).toBe("Under a minute");
    expect(formatStudyDuration(59_999)).toBe("Under a minute");
  });

  it("rounds to whole minutes below an hour", () => {
    expect(formatStudyDuration(60_000)).toBe("1 min");
    expect(formatStudyDuration(125_000)).toBe("2 min");
    expect(formatStudyDuration(89_999)).toBe("1 min");
    expect(formatStudyDuration(90_000)).toBe("2 min");
  });

  it("composes hours and minutes at an hour and beyond", () => {
    expect(formatStudyDuration(3_600_000)).toBe("1 hr");
    expect(formatStudyDuration(3_599_999)).toBe("1 hr"); // rounds up to 60 min
    expect(formatStudyDuration(5_400_000)).toBe("1 hr 30 min");
    expect(formatStudyDuration(7_200_000)).toBe("2 hr");
  });
});
