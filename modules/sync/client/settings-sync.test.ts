import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_DEFAULTS } from "@/modules/profile/session-defaults-core";

import { foldPulledSettings, mapLocalSettingToWire } from "./settings-sync";

describe("mapLocalSettingToWire", () => {
  it("maps a valid arabic-font-scale to the server key", () => {
    const out = mapLocalSettingToWire("arabic-font-scale", "large", 10);
    expect(out).toEqual([
      { key: "arabicFontScale", value: "large", updatedAt: 10 },
    ]);
  });

  it("drops an invalid arabic-font-scale value", () => {
    expect(mapLocalSettingToWire("arabic-font-scale", 1.7, 10)).toEqual([]);
  });

  it("maps a valid theme", () => {
    expect(mapLocalSettingToWire("theme", "dark", 5)).toEqual([
      { key: "theme", value: "dark", updatedAt: 5 },
    ]);
  });

  it("drops an invalid theme value", () => {
    expect(mapLocalSettingToWire("theme", "neon", 5)).toEqual([]);
  });

  it("maps an iana timezone to {mode,name}", () => {
    expect(
      mapLocalSettingToWire(
        "timezone",
        { mode: "iana", timezone: "Europe/London" },
        7,
      ),
    ).toEqual([
      {
        key: "timezone",
        value: { mode: "iana", name: "Europe/London" },
        updatedAt: 7,
      },
    ]);
  });

  it("maps a browser timezone (and sanitises an invalid one to browser)", () => {
    expect(mapLocalSettingToWire("timezone", { mode: "browser" }, 7)).toEqual([
      { key: "timezone", value: { mode: "browser" }, updatedAt: 7 },
    ]);
    // An invalid/absent preference sanitises to browser, never garbage.
    expect(mapLocalSettingToWire("timezone", { mode: "iana" }, 7)).toEqual([
      { key: "timezone", value: { mode: "browser" }, updatedAt: 7 },
    ]);
  });

  it("expands session-defaults into the four server keys", () => {
    const out = mapLocalSettingToWire(
      "session-defaults",
      { questionCount: 15, optionCount: 4, newPerDay: 8, reviewsPerDay: 30 },
      9,
    );
    expect(out).toEqual([
      { key: "questionCount", value: 15, updatedAt: 9 },
      { key: "optionCount", value: 4, updatedAt: 9 },
      { key: "dailyNewTarget", value: 8, updatedAt: 9 },
      { key: "dailyReviewTarget", value: 30, updatedAt: 9 },
    ]);
  });

  it("does not sync a non-account-safe key (register-prompt-dismissed / internal)", () => {
    expect(mapLocalSettingToWire("register-prompt-dismissed", true, 1)).toEqual(
      [],
    );
    expect(mapLocalSettingToWire("study:client-sequence", 42, 1)).toEqual([]);
  });
});

describe("foldPulledSettings (server → local)", () => {
  it("maps the 1:1 keys back to their local kebab keys and reshapes timezone", () => {
    const folded = foldPulledSettings(
      [
        { key: "arabicFontScale", value: "large", updatedAt: 1 },
        { key: "theme", value: "dark", updatedAt: 2 },
        {
          key: "timezone",
          value: { mode: "iana", name: "Europe/London" },
          updatedAt: 3,
        },
      ],
      DEFAULT_SESSION_DEFAULTS,
    );
    expect(folded.directPuts).toEqual([
      { key: "arabic-font-scale", value: "large", updatedAt: 1 },
      { key: "theme", value: "dark", updatedAt: 2 },
      {
        key: "timezone",
        value: { mode: "iana", timezone: "Europe/London" },
        updatedAt: 3,
      },
    ]);
    expect(folded.sessionDefaults).toBeNull();
  });

  it("merges the four session-defaults keys into one local blob (partial page keeps other fields)", () => {
    const current = { ...DEFAULT_SESSION_DEFAULTS, questionCount: 20 };
    const folded = foldPulledSettings(
      [
        { key: "questionCount", value: 15, updatedAt: 5 },
        { key: "dailyNewTarget", value: 8, updatedAt: 7 },
      ],
      current,
    );
    expect(folded.directPuts).toHaveLength(0);
    expect(folded.sessionDefaults).toEqual({
      questionCount: 15, // updated
      optionCount: current.optionCount, // preserved
      newPerDay: 8, // updated (dailyNewTarget → newPerDay)
      reviewsPerDay: current.reviewsPerDay, // preserved
    });
    expect(folded.sessionDefaultsUpdatedAt).toBe(7); // newest of the two
  });

  it("ignores unknown/non-syncable server keys", () => {
    const folded = foldPulledSettings(
      [{ key: "somethingElse", value: 1, updatedAt: 1 }],
      DEFAULT_SESSION_DEFAULTS,
    );
    expect(folded.directPuts).toHaveLength(0);
    expect(folded.sessionDefaults).toBeNull();
  });

  it("is the round-trip inverse of mapLocalSettingToWire for session-defaults", () => {
    const local = {
      questionCount: 12,
      optionCount: 5,
      newPerDay: 3,
      reviewsPerDay: 40,
    };
    const wire = mapLocalSettingToWire("session-defaults", local, 9);
    const folded = foldPulledSettings(wire, DEFAULT_SESSION_DEFAULTS);
    expect(folded.sessionDefaults).toEqual(local);
  });

  it("round-trips every 1:1 syncable setting (push→wire→fold→local) — drift guard (ARCH-001)", () => {
    const cases: { localKey: string; value: unknown }[] = [
      { localKey: "arabic-font-scale", value: "large" },
      { localKey: "theme", value: "dark" },
      {
        localKey: "timezone",
        value: { mode: "iana", timezone: "Europe/London" },
      },
    ];
    for (const c of cases) {
      const wire = mapLocalSettingToWire(c.localKey, c.value, 1);
      // If a key is added to the push mapping but not the fold, this fails.
      expect(wire.length).toBeGreaterThan(0);
      const folded = foldPulledSettings(wire, DEFAULT_SESSION_DEFAULTS);
      expect(folded.directPuts).toEqual([
        { key: c.localKey, value: c.value, updatedAt: 1 },
      ]);
    }
  });

  it("drops an invalid pulled theme/font value rather than storing it (REL-001)", () => {
    const folded = foldPulledSettings(
      [
        { key: "theme", value: "neon", updatedAt: 1 },
        { key: "arabicFontScale", value: 1.7, updatedAt: 1 },
      ],
      DEFAULT_SESSION_DEFAULTS,
    );
    expect(folded.directPuts).toHaveLength(0);
  });

  it("does not advance session-defaults updatedAt for a skipped non-numeric value (REL-002)", () => {
    const folded = foldPulledSettings(
      [
        { key: "questionCount", value: 15, updatedAt: 3 },
        { key: "optionCount", value: "oops", updatedAt: 99 }, // skipped
      ],
      DEFAULT_SESSION_DEFAULTS,
    );
    expect(folded.sessionDefaults?.questionCount).toBe(15);
    expect(folded.sessionDefaults?.optionCount).toBe(
      DEFAULT_SESSION_DEFAULTS.optionCount,
    ); // unchanged
    expect(folded.sessionDefaultsUpdatedAt).toBe(3); // NOT 99
  });
});
