/**
 * Session defaults (Phase 11, §4.4): the 20/4/10/20 documented defaults,
 * per-field sanitisation of stored values, and durable guest persistence.
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import { peekDeviceProfile } from "@/modules/profile/device";
import {
  DEFAULT_SESSION_DEFAULTS,
  persistSessionDefaults,
  readSessionDefaults,
  sanitizeSessionDefaults,
  SESSION_DEFAULTS_BOUNDS,
} from "@/modules/profile/session-defaults";
import {
  readSetting,
  SETTING_KEYS,
  writeSetting,
} from "@/modules/profile/settings";

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-session-defaults-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
});

describe("sanitizeSessionDefaults", () => {
  it("returns the documented 20/4/10/20 defaults for absent or junk input", () => {
    expect(DEFAULT_SESSION_DEFAULTS).toEqual({
      questionCount: 20,
      optionCount: 4,
      newPerDay: 10,
      reviewsPerDay: 20,
    });
    expect(sanitizeSessionDefaults(undefined)).toEqual(
      DEFAULT_SESSION_DEFAULTS,
    );
    expect(sanitizeSessionDefaults(null)).toEqual(DEFAULT_SESSION_DEFAULTS);
    expect(sanitizeSessionDefaults("garbage")).toEqual(
      DEFAULT_SESSION_DEFAULTS,
    );
  });

  it("sanitises per field: a bad field falls back while good fields survive", () => {
    expect(
      sanitizeSessionDefaults({
        questionCount: 35,
        optionCount: 99, // out of range → default 4
        newPerDay: "ten", // wrong type → default 10
        reviewsPerDay: 0, // valid bound
      }),
    ).toEqual({
      questionCount: 35,
      optionCount: 4,
      newPerDay: 10,
      reviewsPerDay: 0,
    });
  });

  it("rejects non-integers and out-of-bounds values", () => {
    expect(
      sanitizeSessionDefaults({
        questionCount: 2.5,
        optionCount: 1,
        newPerDay: -1,
        reviewsPerDay: Number.POSITIVE_INFINITY,
      }),
    ).toEqual(DEFAULT_SESSION_DEFAULTS);
  });

  it("option-count bounds match the generator's supported range", () => {
    expect(SESSION_DEFAULTS_BOUNDS.optionCount).toEqual({ min: 2, max: 8 });
  });
});

describe("readSessionDefaults / persistSessionDefaults", () => {
  it("reads the documented defaults from an empty store", async () => {
    expect(await readSessionDefaults(db)).toEqual(DEFAULT_SESSION_DEFAULTS);
  });

  it("round-trips persisted values and sanitises before writing", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const stored = await persistSessionDefaults(
      db,
      { questionCount: 12, optionCount: 6, newPerDay: 5, reviewsPerDay: 40 },
      { persist },
    );
    expect(stored).toEqual({
      questionCount: 12,
      optionCount: 6,
      newPerDay: 5,
      reviewsPerDay: 40,
    });
    expect(await readSessionDefaults(db)).toEqual(stored);
    // Written as a durable GUEST action: the device profile was minted.
    expect(await peekDeviceProfile(db)).not.toBeNull();
    expect(persist).toHaveBeenCalled();
  });

  it("never stores an out-of-range row (sanitised before the write)", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    await persistSessionDefaults(
      db,
      { questionCount: 0, optionCount: 100, newPerDay: 10, reviewsPerDay: 20 },
      { persist },
    );
    expect(await readSetting(db, SETTING_KEYS.sessionDefaults)).toEqual(
      DEFAULT_SESSION_DEFAULTS,
    );
  });

  it("sanitises a corrupt stored row on read", async () => {
    await writeSetting(
      db,
      SETTING_KEYS.sessionDefaults,
      { questionCount: 50, optionCount: "four" },
      () => 1,
    );
    expect(await readSessionDefaults(db)).toEqual({
      ...DEFAULT_SESSION_DEFAULTS,
      questionCount: 50,
    });
  });
});
