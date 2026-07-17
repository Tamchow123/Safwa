import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ARABIC_FONT_SCALE_CSS_PROPERTY,
  ARABIC_FONT_SCALE_STORAGE_KEY,
  applyArabicFontScale,
  DEFAULT_ARABIC_FONT_SCALE,
  parseArabicFontScale,
  readArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";
import {
  forgetClientArabicFontScaleForTests,
  useArabicFontScale,
} from "@/lib/preferences/use-arabic-font-scale";

describe("arabic font scale (pure logic)", () => {
  it("uses a namespaced, versioned storage key", () => {
    expect(ARABIC_FONT_SCALE_STORAGE_KEY).toBe(
      "safwa:settings:arabic-font-scale",
    );
  });

  it("parses valid values and falls back safely on invalid ones", () => {
    expect(parseArabicFontScale("small")).toBe("small");
    expect(parseArabicFontScale("large")).toBe("large");
    expect(parseArabicFontScale("huge")).toBe(DEFAULT_ARABIC_FONT_SCALE);
    expect(parseArabicFontScale(null)).toBe(DEFAULT_ARABIC_FONT_SCALE);
    expect(parseArabicFontScale(1.2)).toBe(DEFAULT_ARABIC_FONT_SCALE);
    expect(parseArabicFontScale("constructor")).toBe(DEFAULT_ARABIC_FONT_SCALE);
  });

  it("returns the default when storage is empty or throws", () => {
    expect(readArabicFontScale({ getItem: () => null })).toBe(
      DEFAULT_ARABIC_FONT_SCALE,
    );
    expect(
      readArabicFontScale({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(DEFAULT_ARABIC_FONT_SCALE);
  });

  it("applies the numeric scale as a CSS custom property", () => {
    const root = document.createElement("div");
    applyArabicFontScale(root, "large");
    expect(root.style.getPropertyValue(ARABIC_FONT_SCALE_CSS_PROPERTY)).toBe(
      "1.2",
    );
  });
});

describe("useArabicFontScale (hook)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.style.removeProperty(
      ARABIC_FONT_SCALE_CSS_PROPERTY,
    );
    // Each test simulates a fresh page load: the module-level snapshot must
    // re-seed from the mirror, not carry over from the previous test.
    forgetClientArabicFontScaleForTests();
  });

  it("defaults when storage is empty", () => {
    const { result } = renderHook(() => useArabicFontScale());
    expect(result.current.scale).toBe(DEFAULT_ARABIC_FONT_SCALE);
  });

  it("restores a valid stored value", () => {
    window.localStorage.setItem(ARABIC_FONT_SCALE_STORAGE_KEY, "large");
    const { result } = renderHook(() => useArabicFontScale());
    expect(result.current.scale).toBe("large");
  });

  it("falls back safely on an invalid stored value", () => {
    window.localStorage.setItem(ARABIC_FONT_SCALE_STORAGE_KEY, "gigantic");
    const { result } = renderHook(() => useArabicFontScale());
    expect(result.current.scale).toBe(DEFAULT_ARABIC_FONT_SCALE);
  });

  it("setScale persists and updates the document CSS property", () => {
    const { result } = renderHook(() => useArabicFontScale());
    act(() => {
      result.current.setScale("small");
    });
    expect(result.current.scale).toBe("small");
    expect(window.localStorage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY)).toBe(
      "small",
    );
    expect(
      document.documentElement.style.getPropertyValue(
        ARABIC_FONT_SCALE_CSS_PROPERTY,
      ),
    ).toBe("0.9");
  });

  it("reset restores the default", () => {
    window.localStorage.setItem(ARABIC_FONT_SCALE_STORAGE_KEY, "large");
    const { result } = renderHook(() => useArabicFontScale());
    act(() => {
      result.current.reset();
    });
    expect(result.current.scale).toBe(DEFAULT_ARABIC_FONT_SCALE);
    expect(
      document.documentElement.style.getPropertyValue(
        ARABIC_FONT_SCALE_CSS_PROPERTY,
      ),
    ).toBe("1");
  });
});
