import { describe, expect, it } from "vitest";

import { mapLocalSettingToWire } from "./settings-sync";

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
