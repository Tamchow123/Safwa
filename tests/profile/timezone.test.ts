/**
 * Timezone preference (Phase 12 §10): validation by Intl construction,
 * sanitise-on-read/write, browser-detection default, the shared
 * effective-clock resolver, and durable guest persistence. Every stored
 * invalid value must fall back safely to browser detection.
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import { peekDeviceProfile } from "@/modules/profile/device";
import {
  readSetting,
  SETTING_KEYS,
  writeSetting,
} from "@/modules/profile/settings";
import {
  availableTimezones,
  DEFAULT_TIMEZONE_PREFERENCE,
  detectBrowserTimezone,
  isValidTimezone,
  persistTimezonePreference,
  readEffectiveClock,
  readTimezonePreference,
  resolveEffectiveClock,
  sanitizeTimezonePreference,
} from "@/modules/profile/timezone";

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-timezone-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
  vi.restoreAllMocks();
});

describe("isValidTimezone", () => {
  it("accepts UTC and real IANA zones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Asia/Karachi")).toBe(true);
    expect(isValidTimezone("Pacific/Chatham")).toBe(true);
  });

  it("rejects blank and garbage strings", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("   ")).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("Mars/OlympusMons")).toBe(false);
  });
});

describe("sanitizeTimezonePreference", () => {
  it("passes through a valid explicit IANA preference", () => {
    expect(
      sanitizeTimezonePreference({ mode: "iana", timezone: "Asia/Tokyo" }),
    ).toEqual({ mode: "iana", timezone: "Asia/Tokyo" });
  });

  it("passes through browser mode", () => {
    expect(sanitizeTimezonePreference({ mode: "browser" })).toEqual({
      mode: "browser",
    });
  });

  it("falls back to browser mode for every invalid shape", () => {
    for (const junk of [
      undefined,
      null,
      "",
      "Asia/Tokyo", // bare string, not the tagged shape
      42,
      {},
      { mode: "iana" }, // missing timezone
      { mode: "iana", timezone: "" }, // ambiguous empty string
      { mode: "iana", timezone: "Not/AZone" },
      { mode: "iana", timezone: 7 },
      { mode: "gps", timezone: "UTC" },
    ]) {
      expect(sanitizeTimezonePreference(junk)).toEqual(
        DEFAULT_TIMEZONE_PREFERENCE,
      );
    }
  });
});

describe("read / persist (guest-durable settings path)", () => {
  it("absent setting reads as browser mode", async () => {
    expect(await readTimezonePreference(db)).toEqual({ mode: "browser" });
  });

  it("a corrupt stored row falls back to browser mode", async () => {
    await writeSetting(db, SETTING_KEYS.timezone, {
      mode: "iana",
      timezone: "Broken/Zone",
    });
    expect(await readTimezonePreference(db)).toEqual({ mode: "browser" });
  });

  it("persists a valid zone through the guest-durable path (profile minted)", async () => {
    const stored = await persistTimezonePreference(db, {
      mode: "iana",
      timezone: "Asia/Tokyo",
    });
    expect(stored).toEqual({ mode: "iana", timezone: "Asia/Tokyo" });
    expect(await readSetting(db, SETTING_KEYS.timezone)).toEqual(stored);
    // writeGuestSetting arms durable guest state: the device profile exists.
    expect(await peekDeviceProfile(db)).not.toBeNull();
    expect(await readTimezonePreference(db)).toEqual(stored);
  });

  it("sanitises BEFORE writing: an invalid choice stores browser mode", async () => {
    const stored = await persistTimezonePreference(db, {
      mode: "iana",
      timezone: "Not/AZone",
    });
    expect(stored).toEqual({ mode: "browser" });
    expect(await readSetting(db, SETTING_KEYS.timezone)).toEqual({
      mode: "browser",
    });
  });
});

describe("resolveEffectiveClock (§10.5)", () => {
  const FIXED = 1_784_000_000_000;
  const now = () => FIXED;

  it("browser mode → detected zone + browser_detected", () => {
    const clock = resolveEffectiveClock({ mode: "browser" }, now);
    expect(clock.timezone).toBe(detectBrowserTimezone());
    expect(clock.timezoneSource).toBe("browser_detected");
    expect(clock.now()).toBe(FIXED);
  });

  it("explicit valid IANA mode → selected zone + user_setting", () => {
    const clock = resolveEffectiveClock(
      { mode: "iana", timezone: "Asia/Tokyo" },
      now,
    );
    expect(clock.timezone).toBe("Asia/Tokyo");
    expect(clock.timezoneSource).toBe("user_setting");
  });

  it("UTC is a valid explicit zone", () => {
    const clock = resolveEffectiveClock({ mode: "iana", timezone: "UTC" }, now);
    expect(clock.timezone).toBe("UTC");
    expect(clock.timezoneSource).toBe("user_setting");
  });

  it("an unusable explicit zone falls back to browser detection", () => {
    const clock = resolveEffectiveClock(
      { mode: "iana", timezone: "Broken/Zone" },
      now,
    );
    expect(clock.timezone).toBe(detectBrowserTimezone());
    expect(clock.timezoneSource).toBe("browser_detected");
  });

  it("readEffectiveClock resolves the STORED preference", async () => {
    await persistTimezonePreference(db, {
      mode: "iana",
      timezone: "America/New_York",
    });
    const clock = await readEffectiveClock(db);
    expect(clock.timezone).toBe("America/New_York");
    expect(clock.timezoneSource).toBe("user_setting");
  });

  it("a session resolved AFTER a preference change uses the new zone (§10.6/§23)", async () => {
    // Each readEffectiveClock call models one session mount. Changing the
    // stored preference between mounts must change the next resolution —
    // no caching layer may ever pin the first-read zone.
    await persistTimezonePreference(db, {
      mode: "iana",
      timezone: "Asia/Tokyo",
    });
    const first = await readEffectiveClock(db);
    expect(first.timezone).toBe("Asia/Tokyo");

    await persistTimezonePreference(db, {
      mode: "iana",
      timezone: "Europe/London",
    });
    const second = await readEffectiveClock(db);
    expect(second.timezone).toBe("Europe/London");
    expect(second.timezone).not.toBe(first.timezone);
    expect(second.timezoneSource).toBe("user_setting");

    // And back to browser mode: the third session follows the browser again.
    await persistTimezonePreference(db, { mode: "browser" });
    const third = await readEffectiveClock(db);
    expect(third.timezone).toBe(detectBrowserTimezone());
    expect(third.timezoneSource).toBe("browser_detected");
  });
});

describe("availableTimezones (picker list)", () => {
  it("includes UTC and the detected browser zone, sorted and unique", () => {
    const zones = availableTimezones();
    expect(zones).toContain("UTC");
    expect(zones).toContain(detectBrowserTimezone());
    expect([...zones].sort((a, b) => a.localeCompare(b, "en"))).toEqual(zones);
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("falls back safely when Intl.supportedValuesOf is absent", () => {
    const original = Intl.supportedValuesOf;
    // Simulate an older runtime without the API.
    (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = undefined;
    try {
      const zones = availableTimezones();
      expect(zones).toContain("UTC");
      expect(zones).toContain(detectBrowserTimezone());
    } finally {
      (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = original;
    }
  });
});
