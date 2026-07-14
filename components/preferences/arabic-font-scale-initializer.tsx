"use client";

import { useEffect } from "react";

import {
  applyArabicFontScale,
  readArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";

/**
 * Applies the stored Arabic text-size preference on first load so every page
 * (not just Settings) renders Arabic at the chosen size.
 */
export function ArabicFontScaleInitializer() {
  useEffect(() => {
    applyArabicFontScale(
      document.documentElement,
      readArabicFontScale(window.localStorage),
    );
  }, []);

  return null;
}
