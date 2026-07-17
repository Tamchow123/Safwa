import "fake-indexeddb/auto";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARABIC_FONT_SCALE_STORAGE_KEY,
  ARABIC_FONT_SCALE_CSS_PROPERTY,
} from "@/lib/preferences/arabic-font-scale";
import {
  forgetClientArabicFontScaleForTests,
  reconcileArabicFontScaleFromDb,
  useArabicFontScale,
  watchArabicFontScaleMirror,
} from "@/lib/preferences/use-arabic-font-scale";
import { getSafwaDb } from "@/modules/content/db";
import { SETTING_KEYS, writeSetting } from "@/modules/profile/settings";

// The hook reads through the real browser singleton; tests seed and clear
// that same database.
const db = getSafwaDb();

beforeEach(async () => {
  await db.settings.clear();
  await db.profile.clear();
  window.localStorage.clear();
  document.documentElement.style.removeProperty(ARABIC_FONT_SCALE_CSS_PROPERTY);
  // Recreate the fresh-page-load precondition: the module-level snapshot
  // must be unseeded so the next read comes from the (now empty) mirror.
  forgetClientArabicFontScaleForTests();
});

afterAll(async () => {
  await db.delete();
});

describe("reconcileArabicFontScaleFromDb", () => {
  it("applies the durable Dexie value to the mirror and the document", async () => {
    await writeSetting(db, SETTING_KEYS.arabicFontScale, "small");
    await reconcileArabicFontScaleFromDb();
    expect(window.localStorage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY)).toBe(
      "small",
    );
    expect(
      document.documentElement.style.getPropertyValue(
        ARABIC_FONT_SCALE_CSS_PROPERTY,
      ),
    ).toBe("0.9");
  });

  it("never clobbers a user choice made while its read was in flight", async () => {
    // Dexie holds a stale "small" from a previous session.
    await writeSetting(db, SETTING_KEYS.arabicFontScale, "small");
    const { result } = renderHook(() => useArabicFontScale());

    // Start the app-load reconcile, then pick a scale BEFORE it resolves —
    // deterministic, because the Dexie read cannot complete synchronously.
    const reconcile = reconcileArabicFontScaleFromDb();
    act(() => {
      result.current.setScale("large");
    });
    await act(async () => {
      await reconcile;
    });

    // The user's mid-flight choice wins everywhere…
    expect(result.current.scale).toBe("large");
    expect(window.localStorage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY)).toBe(
      "large",
    );
    expect(
      document.documentElement.style.getPropertyValue(
        ARABIC_FONT_SCALE_CSS_PROPERTY,
      ),
    ).toBe("1.2");
    // …including durably, via the fire-and-forget Dexie write.
    await waitFor(async () => {
      const record = await db.settings.get(SETTING_KEYS.arabicFontScale);
      expect(record?.value).toBe("large");
    });
  });

  it("manufactures no stored 'default' for a fresh guest (both stores stay empty)", async () => {
    // A passive load with no value anywhere must not stamp an explicit
    // "default" into the mirror — that synthetic value would later be
    // migrated into Dexie and exported as a choice the user never made.
    await reconcileArabicFontScaleFromDb();
    expect(window.localStorage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY)).toBe(
      null,
    );
    expect(await db.settings.count()).toBe(0);
  });

  it("keeps the UI, CSS and Dexie coherent when the mirror write fails", async () => {
    // Quota-blocked Web Storage: setItem throws, but the user's choice
    // must still hold in React state, on the document, and durably.
    const { result } = renderHook(() => useArabicFontScale());
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      act(() => {
        result.current.setScale("large");
      });
      expect(result.current.scale).toBe("large");
      expect(
        document.documentElement.style.getPropertyValue(
          ARABIC_FONT_SCALE_CSS_PROPERTY,
        ),
      ).toBe("1.2");
      // The mirror could not be written (it stays empty)…
      expect(window.localStorage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY)).toBe(
        null,
      );
      // …but the durable copy still lands.
      await waitFor(async () => {
        const record = await db.settings.get(SETTING_KEYS.arabicFontScale);
        expect(record?.value).toBe("large");
      });
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("watchArabicFontScaleMirror", () => {
  it("adopts a cross-tab change made while no component was mounted", () => {
    // Seed the snapshot, then unmount everything — the Codex-reported
    // scenario: this tab shows the dashboard (no scale consumer mounted)
    // while another tab changes the setting.
    const first = renderHook(() => useArabicFontScale());
    expect(first.result.current.scale).toBe("default");
    first.unmount();

    const unwatch = watchArabicFontScaleMirror();
    try {
      // Simulate the other tab's write: localStorage changes and the
      // browser delivers a `storage` event (same-tab writes never do).
      window.localStorage.setItem(ARABIC_FONT_SCALE_STORAGE_KEY, "large");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: ARABIC_FONT_SCALE_STORAGE_KEY,
          newValue: "large",
        }),
      );
      // The CSS updates immediately, before any component mounts…
      expect(
        document.documentElement.style.getPropertyValue(
          ARABIC_FONT_SCALE_CSS_PROPERTY,
        ),
      ).toBe("1.2");
      // …and a component mounting later reads the fresh value, not the
      // stale cached snapshot.
      const second = renderHook(() => useArabicFontScale());
      expect(second.result.current.scale).toBe("large");
      second.unmount();
    } finally {
      unwatch();
    }
  });

  it("ignores unrelated-key events so a failed same-tab mirror write survives", () => {
    const unwatch = watchArabicFontScaleMirror();
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      // The user's choice holds in memory even though the mirror write
      // failed (the mirror still has no value)…
      const { result } = renderHook(() => useArabicFontScale());
      act(() => {
        result.current.setScale("large");
      });
      expect(result.current.scale).toBe("large");
      // …and another tab touching a DIFFERENT key must not re-seed the
      // snapshot from the stale mirror.
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", { key: "theme", newValue: "dark" }),
        );
      });
      expect(result.current.scale).toBe("large");
    } finally {
      setItem.mockRestore();
      unwatch();
    }
  });
});
