"use client";

import { useEffect } from "react";

import {
  applyArabicFontScale,
  readArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";
import {
  reconcileArabicFontScaleFromDb,
  watchArabicFontScaleMirror,
} from "@/lib/preferences/use-arabic-font-scale";

/**
 * Applies the stored Arabic text-size preference on first load so every page
 * (not just Settings) renders Arabic at the chosen size: the localStorage
 * mirror applies synchronously, then the durable Dexie value reconciles it
 * (restoring the setting even if localStorage was cleared). Also watches
 * cross-tab mirror changes for the app's lifetime, so a change made in
 * another tab is adopted even while no scale-consuming component is mounted.
 */
export function ArabicFontScaleInitializer() {
  useEffect(() => {
    applyArabicFontScale(
      document.documentElement,
      readArabicFontScale(window.localStorage),
    );
    void reconcileArabicFontScaleFromDb();
    return watchArabicFontScaleMirror();
  }, []);

  return null;
}
