import "fake-indexeddb/auto";

import { waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_THEME_STORAGE_KEY } from "@/lib/preferences/app-theme";
import { watchThemeMirrorRemoval } from "@/lib/preferences/use-app-theme";
import { getSafwaDb } from "@/modules/content/db";
import { SETTING_KEYS, writeSetting } from "@/modules/profile/settings";

// The watcher reads through the real browser singleton; tests seed and
// clear that same database.
const db = getSafwaDb();

beforeEach(async () => {
  await db.settings.clear();
  await db.profile.clear();
  window.localStorage.clear();
});

afterAll(async () => {
  await db.delete();
});

function dispatchThemeStorageEvent(newValue: string | null) {
  window.dispatchEvent(
    new StorageEvent("storage", { key: APP_THEME_STORAGE_KEY, newValue }),
  );
}

describe("watchThemeMirrorRemoval", () => {
  it("restores the durable theme when the mirror key is removed in another tab", async () => {
    // next-themes answers a cross-tab removal by writing its DEFAULT back
    // into the mirror, which would win the next mirror-vs-Dexie divergence
    // check and destroy the durable choice — the watcher restores the
    // Dexie value through setTheme instead.
    await writeSetting(db, SETTING_KEYS.theme, "dark");
    const setTheme = vi.fn();
    const unwatch = watchThemeMirrorRemoval(setTheme);
    try {
      dispatchThemeStorageEvent(null);
      await waitFor(() => expect(setTheme).toHaveBeenCalledWith("dark"));
      expect(setTheme).toHaveBeenCalledTimes(1);
    } finally {
      unwatch();
    }
  });

  it("leaves ordinary cross-tab theme CHANGES to next-themes", async () => {
    await writeSetting(db, SETTING_KEYS.theme, "dark");
    const setTheme = vi.fn();
    const unwatch = watchThemeMirrorRemoval(setTheme);
    try {
      // A value change (not a removal) is next-themes' own cross-tab sync;
      // restoring Dexie here would fight the newer tab.
      dispatchThemeStorageEvent("light");
      // Removals of OTHER keys are unrelated.
      window.dispatchEvent(
        new StorageEvent("storage", { key: "unrelated", newValue: null }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setTheme).not.toHaveBeenCalled();
    } finally {
      unwatch();
    }
  });

  it("aborts a pending restore when a newer cross-tab change supersedes it", async () => {
    // The race: a removal starts the async Dexie read; before it lands,
    // the other tab explicitly picks a theme (next-themes syncs it here).
    // The stale restore must NOT revert that newer choice.
    await writeSetting(db, SETTING_KEYS.theme, "dark");
    const setTheme = vi.fn();
    let releaseRead: () => void = () => {};
    const realGet = db.settings.get.bind(db.settings);
    const getSpy = vi.spyOn(db.settings, "get").mockImplementation(
      (key) =>
        new Promise((resolve) => {
          releaseRead = () => resolve(realGet(key as unknown as string));
        }) as unknown as ReturnType<typeof db.settings.get>,
    );
    const unwatch = watchThemeMirrorRemoval(setTheme);
    try {
      dispatchThemeStorageEvent(null); // removal → restore begins, read held open
      dispatchThemeStorageEvent("light"); // the other tab's newer explicit choice
      releaseRead();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setTheme).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      unwatch();
    }
  });

  it("does nothing when Dexie holds no theme to restore", async () => {
    const setTheme = vi.fn();
    const unwatch = watchThemeMirrorRemoval(setTheme);
    try {
      dispatchThemeStorageEvent(null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setTheme).not.toHaveBeenCalled();
    } finally {
      unwatch();
    }
  });
});
