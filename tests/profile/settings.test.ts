import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_THEME_STORAGE_KEY } from "@/lib/preferences/app-theme";
import { ARABIC_FONT_SCALE_STORAGE_KEY } from "@/lib/preferences/arabic-font-scale";
import { SafwaDb } from "@/modules/content/db";
import { peekDeviceProfile } from "@/modules/profile/device";
import {
  dismissRegisterPrompt,
  isRegisterPromptDismissed,
  persistArabicFontScale,
  persistTheme,
  readSetting,
  SETTING_KEYS,
  syncArabicFontScale,
  syncTheme,
  writeGuestSetting,
  writeSetting,
} from "@/modules/profile/settings";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  };
}

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-settings-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
});

describe("settings store", () => {
  it("round-trips values through Dexie", async () => {
    expect(await readSetting(db, "missing")).toBeUndefined();
    await writeSetting(db, "some-key", { nested: true }, () => 42);
    expect(await readSetting(db, "some-key")).toEqual({ nested: true });
    expect(await db.settings.get("some-key")).toEqual({
      key: "some-key",
      value: { nested: true },
      updatedAt: 42,
    });
  });

  it("writeGuestSetting persists the value AND ensures durable guest state", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    await writeGuestSetting(db, "k", "v", { persist });
    expect(await readSetting(db, "k")).toBe("v");
    const profile = await peekDeviceProfile(db);
    expect(profile).not.toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(profile!.persistenceGranted).toBe(true);
  });

  it("never gates the durability boundary behind the setting write", async () => {
    // If the setting write hangs (or is cut off by a closing tab), the
    // profile mint + persist request must already be under way — both
    // halves of a guest action start at the action, concurrently.
    const persist = vi.fn().mockResolvedValue(true);
    vi.spyOn(db.settings, "put").mockReturnValue(
      new Promise<string>(() => {}) as unknown as ReturnType<
        typeof db.settings.put
      >,
    );
    void writeGuestSetting(db, "k", "v", { persist });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect(await peekDeviceProfile(db)).not.toBeNull(),
    );
  });

  it("concurrent guest writes coalesce into one persist request", async () => {
    // The reset-appearance path: theme + font scale written together must
    // produce a single storage-persist request, not one prompt per write.
    const persist = vi.fn().mockResolvedValue(true);
    await Promise.all([
      writeGuestSetting(db, SETTING_KEYS.theme, "dark", { persist }),
      writeGuestSetting(db, SETTING_KEYS.arabicFontScale, "large", {
        persist,
      }),
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await readSetting(db, SETTING_KEYS.theme)).toBe("dark");
    expect(await readSetting(db, SETTING_KEYS.arabicFontScale)).toBe("large");
    const profile = await peekDeviceProfile(db);
    expect(profile).not.toBeNull();
    expect(profile!.persistenceGranted).toBe(true);
  });
});

describe("syncArabicFontScale", () => {
  it("a divergent valid mirror wins over an older Dexie value and heals it", async () => {
    // The failed-durable-write scenario: the user picked "large" (mirror
    // written synchronously) but the fire-and-forget Dexie write never
    // landed — Dexie still holds the previous session's "small". Every
    // writer updates the mirror first, so on divergence the mirror is the
    // newer value; reconciliation must not silently revert the user.
    await writeSetting(db, SETTING_KEYS.arabicFontScale, "small", () => 1);
    const mirror = memoryStorage({ [ARABIC_FONT_SCALE_STORAGE_KEY]: "large" });
    const result = await syncArabicFontScale(db, mirror, () => 2);
    expect(result).toEqual({ effective: "large", restoreMirror: false });
    // …and the durable copy is healed to match the user's choice.
    expect(await db.settings.get(SETTING_KEYS.arabicFontScale)).toEqual({
      key: SETTING_KEYS.arabicFontScale,
      value: "large",
      updatedAt: 2,
    });
    // The heal is a silent write: no profile mint on page load.
    expect(await peekDeviceProfile(db)).toBeNull();
  });

  it("Dexie wins when the mirror is absent (cleared mirror is restorable)", async () => {
    await writeSetting(db, SETTING_KEYS.arabicFontScale, "small");
    const result = await syncArabicFontScale(db, memoryStorage());
    expect(result).toEqual({ effective: "small", restoreMirror: true });
  });

  it("Dexie wins when the mirror holds an invalid value", async () => {
    await writeSetting(db, SETTING_KEYS.arabicFontScale, "small");
    const mirror = memoryStorage({
      [ARABIC_FONT_SCALE_STORAGE_KEY]: "gigantic",
    });
    const result = await syncArabicFontScale(db, mirror);
    expect(result).toEqual({ effective: "small", restoreMirror: true });
    // The invalid mirror value is never "healed" into the durable copy.
    const record = await db.settings.get(SETTING_KEYS.arabicFontScale);
    expect(record?.value).toBe("small");
  });

  it("agreeing stores stay untouched (no redundant write)", async () => {
    await writeSetting(db, SETTING_KEYS.arabicFontScale, "large", () => 7);
    const mirror = memoryStorage({ [ARABIC_FONT_SCALE_STORAGE_KEY]: "large" });
    const result = await syncArabicFontScale(db, mirror, () => 99);
    expect(result).toEqual({ effective: "large", restoreMirror: false });
    expect(
      (await db.settings.get(SETTING_KEYS.arabicFontScale))?.updatedAt,
    ).toBe(7);
  });

  it("migrates a pre-Phase-5 localStorage-only value into Dexie", async () => {
    const mirror = memoryStorage({ [ARABIC_FONT_SCALE_STORAGE_KEY]: "large" });
    const result = await syncArabicFontScale(db, mirror, () => 99);
    expect(result).toEqual({ effective: "large", restoreMirror: false });
    expect(await db.settings.get(SETTING_KEYS.arabicFontScale)).toEqual({
      key: SETTING_KEYS.arabicFontScale,
      value: "large",
      updatedAt: 99,
    });
    // Migration is a silent write: no profile is minted on page load.
    expect(await peekDeviceProfile(db)).toBeNull();
  });

  it("migrates an explicitly stored 'default' mirror value into Dexie", async () => {
    // A missing key and the stored value "default" are distinct: the user
    // explicitly chose this value, so it must not be silently dropped.
    const mirror = memoryStorage({
      [ARABIC_FONT_SCALE_STORAGE_KEY]: "default",
    });
    const result = await syncArabicFontScale(db, mirror, () => 11);
    expect(result).toEqual({ effective: "default", restoreMirror: false });
    expect(await db.settings.get(SETTING_KEYS.arabicFontScale)).toEqual({
      key: SETTING_KEYS.arabicFontScale,
      value: "default",
      updatedAt: 11,
    });
  });

  it("returns the default and writes nothing when neither store has a value", async () => {
    const mirror = memoryStorage();
    const result = await syncArabicFontScale(db, mirror);
    // restoreMirror stays false: an absent setting must never be turned
    // into a manufactured explicit "default" by a passive page load.
    expect(result).toEqual({ effective: "default", restoreMirror: false });
    expect(await db.settings.count()).toBe(0);
  });

  it("ignores an invalid stored value and falls back to the mirror path", async () => {
    await writeSetting(db, SETTING_KEYS.arabicFontScale, "gigantic");
    const mirror = memoryStorage();
    expect(await syncArabicFontScale(db, mirror)).toEqual({
      effective: "default",
      restoreMirror: false,
    });
  });
});

describe("syncTheme", () => {
  it("a divergent valid mirror wins over an older Dexie value and heals it", async () => {
    await writeSetting(db, SETTING_KEYS.theme, "light", () => 1);
    const mirror = memoryStorage({ [APP_THEME_STORAGE_KEY]: "dark" });
    const result = await syncTheme(db, mirror, () => 2);
    expect(result).toEqual({ effective: "dark", restoreMirror: false });
    expect(await db.settings.get(SETTING_KEYS.theme)).toEqual({
      key: SETTING_KEYS.theme,
      value: "dark",
      updatedAt: 2,
    });
    // Silent write: no profile mint on page load.
    expect(await peekDeviceProfile(db)).toBeNull();
  });

  it("flags a restore when Dexie has a value but the mirror is absent", async () => {
    await writeSetting(db, SETTING_KEYS.theme, "dark", () => 7);
    const result = await syncTheme(db, memoryStorage(), () => 9);
    expect(result).toEqual({ effective: "dark", restoreMirror: true });
    // No redundant Dexie write.
    expect((await db.settings.get(SETTING_KEYS.theme))?.updatedAt).toBe(7);
  });

  it("flags a restore when the mirror holds an invalid value", async () => {
    await writeSetting(db, SETTING_KEYS.theme, "dark");
    const mirror = memoryStorage({ [APP_THEME_STORAGE_KEY]: "sepia" });
    const result = await syncTheme(db, mirror);
    expect(result).toEqual({ effective: "dark", restoreMirror: true });
    // The invalid mirror value is never healed into the durable copy.
    expect((await db.settings.get(SETTING_KEYS.theme))?.value).toBe("dark");
  });

  it("agreeing stores stay untouched (no redundant write)", async () => {
    await writeSetting(db, SETTING_KEYS.theme, "system", () => 3);
    const mirror = memoryStorage({ [APP_THEME_STORAGE_KEY]: "system" });
    const result = await syncTheme(db, mirror, () => 42);
    expect(result).toEqual({ effective: "system", restoreMirror: false });
    expect((await db.settings.get(SETTING_KEYS.theme))?.updatedAt).toBe(3);
  });

  it("migrates a mirror-only theme (including 'system') into Dexie", async () => {
    const mirror = memoryStorage({ [APP_THEME_STORAGE_KEY]: "system" });
    const result = await syncTheme(db, mirror, () => 21);
    expect(result).toEqual({ effective: "system", restoreMirror: false });
    expect(await db.settings.get(SETTING_KEYS.theme)).toEqual({
      key: SETTING_KEYS.theme,
      value: "system",
      updatedAt: 21,
    });
    // Migration is a silent write: no profile is minted on page load.
    expect(await peekDeviceProfile(db)).toBeNull();
  });

  it("returns null and writes nothing when neither store has a theme", async () => {
    const result = await syncTheme(db, memoryStorage());
    expect(result).toEqual({ effective: null, restoreMirror: false });
    expect(await db.settings.count()).toBe(0);
  });
});

describe("persistTheme", () => {
  it("records the theme durably as a guest action", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    await persistTheme(db, "dark", { persist });
    expect(await readSetting(db, SETTING_KEYS.theme)).toBe("dark");
    expect(persist).toHaveBeenCalledTimes(1);
    const profile = await peekDeviceProfile(db);
    expect(profile).not.toBeNull();
    expect(profile!.persistenceGranted).toBe(true);
  });
});

describe("persistArabicFontScale", () => {
  it("writes mirror + Dexie and requests persistence as a guest action", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const mirror = memoryStorage();
    await persistArabicFontScale(db, "large", mirror, { persist });
    expect(mirror.dump()[ARABIC_FONT_SCALE_STORAGE_KEY]).toBe("large");
    expect(await readSetting(db, SETTING_KEYS.arabicFontScale)).toBe("large");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await peekDeviceProfile(db)).not.toBeNull();
  });
});

describe("register prompt dismissal", () => {
  it("defaults to not dismissed and records a durable dismissal", async () => {
    expect(await isRegisterPromptDismissed(db)).toBe(false);
    await dismissRegisterPrompt(db);
    expect(await isRegisterPromptDismissed(db)).toBe(true);
    expect(await readSetting(db, SETTING_KEYS.registerPromptDismissed)).toBe(
      true,
    );
  });
});
