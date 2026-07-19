/**
 * Pure ISO-date calendar arithmetic (Phase 12 §8–9): label validity, label
 * succession across month/year/leap/DST boundaries, ranges, and the single
 * Intl-delegated instant→local-date mapping.
 */
import { describe, expect, it } from "vitest";

import {
  addDays,
  daysBetween,
  isIsoDate,
  isNextDay,
  lastNDates,
  localDateForInstant,
  MAX_DATE_RANGE,
} from "@/modules/analytics/dates";

describe("isIsoDate", () => {
  it("accepts real calendar dates", () => {
    expect(isIsoDate("2026-07-19")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true); // leap day
    expect(isIsoDate("2026-12-31")).toBe(true);
    expect(isIsoDate("2026-01-01")).toBe(true);
  });

  it("rejects malformed labels and impossible dates", () => {
    expect(isIsoDate("2026-7-19")).toBe(false);
    expect(isIsoDate("2026/07/19")).toBe(false);
    expect(isIsoDate("2026-07-19T00:00:00Z")).toBe(false);
    expect(isIsoDate("2026-02-29")).toBe(false); // not a leap year
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-00-10")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20260719)).toBe(false);
  });
});

describe("addDays / isNextDay (calendar-label arithmetic, never 24h ms)", () => {
  it("moves within a month", () => {
    expect(addDays("2026-07-10", 1)).toBe("2026-07-11");
    expect(addDays("2026-07-10", -1)).toBe("2026-07-09");
    expect(addDays("2026-07-10", 0)).toBe("2026-07-10");
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles leap days", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // non-leap
  });

  it("succession across DST transition dates is plain label succession", () => {
    // US spring-forward 2026-03-08 (23h day) and fall-back 2026-11-01 (25h
    // day): label arithmetic is immune to day length.
    expect(isNextDay("2026-03-07", "2026-03-08")).toBe(true);
    expect(isNextDay("2026-03-08", "2026-03-09")).toBe(true);
    expect(isNextDay("2026-10-31", "2026-11-01")).toBe(true);
    expect(isNextDay("2026-11-01", "2026-11-02")).toBe(true);
    expect(isNextDay("2026-03-07", "2026-03-09")).toBe(false);
  });
});

describe("daysBetween", () => {
  it("is signed and boundary-safe", () => {
    expect(daysBetween("2026-07-10", "2026-07-19")).toBe(9);
    expect(daysBetween("2026-07-19", "2026-07-10")).toBe(-9);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // leap year
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2026-07-19", "2026-07-19")).toBe(0);
  });
});

describe("lastNDates", () => {
  it("returns the ascending window ending at the anchor", () => {
    expect(lastNDates("2026-07-19", 3)).toEqual([
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
    ]);
    expect(lastNDates("2026-07-19", 1)).toEqual(["2026-07-19"]);
  });

  it("spans month boundaries (the 14-day chart window)", () => {
    const window = lastNDates("2026-08-05", 14);
    expect(window).toHaveLength(14);
    expect(window[0]).toBe("2026-07-23");
    expect(window[13]).toBe("2026-08-05");
    for (let i = 1; i < window.length; i += 1) {
      expect(isNextDay(window[i - 1], window[i])).toBe(true);
    }
  });

  it("rejects a non-positive count", () => {
    expect(() => lastNDates("2026-07-19", 0)).toThrow();
    expect(() => lastNDates("2026-07-19", 1.5)).toThrow();
  });

  it("caps the window at MAX_DATE_RANGE (never an unbounded label array)", () => {
    expect(lastNDates("2026-07-19", MAX_DATE_RANGE)).toHaveLength(
      MAX_DATE_RANGE,
    );
    expect(() => lastNDates("2026-07-19", MAX_DATE_RANGE + 1)).toThrow(
      /positive integer/,
    );
    expect(() => lastNDates("2026-07-19", Number.MAX_SAFE_INTEGER)).toThrow(
      /positive integer/,
    );
  });

  it("every helper fails loudly on a malformed date label", () => {
    // Silent NaN-derived garbage must never propagate (fail-loud posture).
    expect(() => addDays("not-a-date", 1)).toThrow(/valid ISO date/);
    expect(() => addDays("2026-02-30", 1)).toThrow(/valid ISO date/);
    expect(() => daysBetween("garbage", "2026-07-19")).toThrow(
      /valid ISO date/,
    );
    expect(() => daysBetween("2026-07-19", "garbage")).toThrow(
      /valid ISO date/,
    );
    expect(() => isNextDay("2026-02-30", "2026-03-01")).toThrow(
      /valid ISO date/,
    );
    expect(() => lastNDates("garbage", 3)).toThrow(/valid ISO date/);
  });
});

describe("localDateForInstant (delegates to the engine's Intl mapping)", () => {
  it("maps one instant to different labels per zone", () => {
    const instant = Date.UTC(2026, 6, 17, 20, 0, 0); // 2026-07-17T20:00Z
    expect(localDateForInstant(instant, "UTC")).toBe("2026-07-17");
    expect(localDateForInstant(instant, "Asia/Tokyo")).toBe("2026-07-18");
    expect(localDateForInstant(instant, "America/New_York")).toBe("2026-07-17");
  });

  it("is DST-correct at the US spring-forward gap", () => {
    // 2026-03-08 07:30Z = 02:30 EST-less (the skipped hour) → still March 8
    // in New York; 23:30Z the previous day maps to March 7 local (EST).
    expect(
      localDateForInstant(Date.UTC(2026, 2, 8, 7, 30, 0), "America/New_York"),
    ).toBe("2026-03-08");
    expect(
      localDateForInstant(Date.UTC(2026, 2, 8, 4, 30, 0), "America/New_York"),
    ).toBe("2026-03-07");
  });
});
