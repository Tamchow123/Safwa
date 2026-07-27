// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { adoptPulledPreferenceMirrors } from "./adopt-pulled-mirrors";
import { APP_THEME_STORAGE_KEY } from "./app-theme";
import {
  ARABIC_FONT_SCALE_CSS_PROPERTY,
  ARABIC_FONT_SCALE_STORAGE_KEY,
  ARABIC_FONT_SCALES,
} from "./arabic-font-scale";

describe("adoptPulledPreferenceMirrors (R2-F5)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.style.removeProperty(
      ARABIC_FONT_SCALE_CSS_PROPERTY,
    );
  });

  it("forces the theme + font-scale mirrors from server-authoritative values", () => {
    // A stale mirror (as a second context would have) must be overwritten.
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, "light");
    window.localStorage.setItem(ARABIC_FONT_SCALE_STORAGE_KEY, "default");

    adoptPulledPreferenceMirrors({ theme: "dark", arabicFontScale: "large" });

    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY)).toBe(
      "large",
    );
    // The font scale is applied live (we own its store end-to-end).
    expect(
      document.documentElement.style.getPropertyValue(
        ARABIC_FONT_SCALE_CSS_PROPERTY,
      ),
    ).toBe(String(ARABIC_FONT_SCALES.large));
  });

  it("ignores unknown/invalid pulled values rather than mirroring them", () => {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, "light");

    adoptPulledPreferenceMirrors({ theme: "neon", arabicFontScale: 42 });

    // An invalid value never overwrites the mirror.
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("light");
    expect(
      window.localStorage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY),
    ).toBeNull();
  });

  it("is a no-op for an empty pull (no theme/font change)", () => {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, "light");
    adoptPulledPreferenceMirrors({});
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("light");
  });
});
