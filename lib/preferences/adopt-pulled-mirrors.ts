"use client";

/**
 * R2-F5 — adopt server-authoritative pulled preference values into their
 * localStorage MIRRORS. Both the theme and the Arabic font scale keep a
 * synchronous localStorage mirror (read before first paint, which an async
 * Dexie read cannot serve) alongside the durable Dexie copy. The pull writes
 * the authoritative value into Dexie, but the startup reconcile deliberately
 * treats a valid mirror as an interrupted LOCAL write and keeps it — so a
 * pulled value would be shadowed by a stale mirror and never displayed in a
 * second context (§23). This bridges that gap: a pull is account-authoritative,
 * so it force-updates the mirrors (and, for the font scale we fully own, the
 * live in-memory value too). Pure browser side-effect; a no-op on the server.
 */
import { isAppTheme, writeAppThemeMirror } from "./app-theme";
import { isArabicFontScale } from "./arabic-font-scale";
import { adoptPulledArabicFontScale } from "./use-arabic-font-scale";

/** The preference values a pull may carry, before validation. */
export type PulledPreferenceMirrors = {
  theme?: unknown;
  arabicFontScale?: unknown;
};

/**
 * Force the mirrors for whichever preference values the pull carried. Each is
 * validated before adoption (an unknown/invalid value is ignored, never
 * mirrored). The theme mirror is next-themes' pre-paint source, so writing it
 * makes the pulled theme win on the next load; the font scale is adopted live
 * (mirror + in-memory + applied CSS) because we own its store end-to-end.
 */
export function adoptPulledPreferenceMirrors(
  prefs: PulledPreferenceMirrors,
): void {
  if (typeof window === "undefined") return;
  if (isAppTheme(prefs.theme)) {
    writeAppThemeMirror(window.localStorage, prefs.theme);
  }
  if (isArabicFontScale(prefs.arabicFontScale)) {
    adoptPulledArabicFontScale(prefs.arabicFontScale);
  }
}
