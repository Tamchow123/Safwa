"use client";

import { useTheme } from "next-themes";
import { useCallback } from "react";

import {
  APP_THEME_STORAGE_KEY,
  isAppTheme,
  type AppTheme,
} from "@/lib/preferences/app-theme";
import { getSafwaDb } from "@/modules/content/db";
import {
  persistTheme,
  readSetting,
  SETTING_KEYS,
  syncTheme,
} from "@/modules/profile/settings";

/*
 * Storage model (Phase 5), matching the Arabic font scale: Dexie is the
 * durable authority for the theme; next-themes' localStorage key stays the
 * synchronous mirror (its inline script applies the class before first
 * paint, which an async store cannot). Explicit user changes go through
 * setAppTheme: next-themes writes the mirror and the DOM synchronously,
 * then the value is recorded durably as a guest action (profile mint +
 * storage-persist request via the writeGuestSetting boundary).
 */

/**
 * Counts user-initiated theme writes so an in-flight reconcile can detect
 * that its Dexie read went stale mid-await and must not override the
 * user's just-made choice.
 */
let themeWriteCount = 0;

/**
 * Persist a user-chosen theme durably. Fire-and-forget from the setter —
 * next-themes has already updated the UI; a Dexie failure only weakens
 * durability, never the current session.
 */
async function persistThemeDurably(next: AppTheme): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    await persistTheme(getSafwaDb(), next, navigator.storage);
  } catch {
    // Best-effort durable write; the mirror still applies.
  }
}

/**
 * Restore the durable (Dexie) theme when next-themes' localStorage mirror
 * was cleared or corrupted, and migrate a mirror-only value into Dexie.
 * Called once at app start. Never throws: without IndexedDB the mirror
 * value keeps applying unchanged.
 */
export async function reconcileThemeFromDb(
  setTheme: (theme: string) => void,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const observedWrites = themeWriteCount;
  try {
    const { effective, restoreMirror } = await syncTheme(
      getSafwaDb(),
      window.localStorage,
    );
    if (themeWriteCount !== observedWrites) {
      // The user picked a theme while the read was in flight; their write
      // is newer (and persistThemeDurably is carrying it into Dexie).
      return;
    }
    if (effective !== null && restoreMirror) {
      setTheme(effective);
    }
  } catch {
    // Dexie unavailable (private mode, quota): the mirror still applies.
  }
}

/**
 * Restore the durable theme when the mirror KEY IS REMOVED in another tab.
 *
 * next-themes' own storage handler reacts to a removal by calling
 * setTheme(defaultTheme), which WRITES the default back into the mirror —
 * so by the next app load the cleared mirror looks like an explicitly
 * chosen "system" and would win the mirror-vs-Dexie divergence check,
 * silently destroying the durable value. The mirror-wins rule is built on
 * "every mirror write is a user choice"; next-themes' automatic write-back
 * is the one writer that breaks that assumption, so removal events bypass
 * the rule: the Dexie value is pushed back through setTheme (overwriting
 * next-themes' default in state AND mirror). Ordinary cross-tab theme
 * CHANGES (newValue present) stay next-themes' job and are not overridden
 * — including when one arrives while a removal restore's Dexie read is
 * still in flight, which is why every theme-key event advances a
 * generation counter that a pending restore must still match before it
 * may call setTheme.
 */
let themeMirrorGeneration = 0;

export function watchThemeMirrorRemoval(
  setTheme: (theme: string) => void,
): () => void {
  const onStorageEvent = (event: StorageEvent) => {
    if (event.key !== APP_THEME_STORAGE_KEY) return;
    themeMirrorGeneration += 1;
    if (event.newValue !== null) return;
    void restoreThemeAfterMirrorRemoval(setTheme, themeMirrorGeneration);
  };
  window.addEventListener("storage", onStorageEvent);
  return () => window.removeEventListener("storage", onStorageEvent);
}

async function restoreThemeAfterMirrorRemoval(
  setTheme: (theme: string) => void,
  generation: number,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const observedWrites = themeWriteCount;
  try {
    const stored = await readSetting(getSafwaDb(), SETTING_KEYS.theme);
    if (themeWriteCount !== observedWrites) {
      // The user picked a theme in THIS tab while the Dexie read was in
      // flight; their choice is newer than the stored value.
      return;
    }
    if (themeMirrorGeneration !== generation) {
      // Another theme-key event (a newer cross-tab choice, or a later
      // removal with its own restore) superseded this one while the read
      // was in flight; restoring now would revert the newer state.
      return;
    }
    if (isAppTheme(stored)) {
      setTheme(stored);
    }
  } catch {
    // Dexie unavailable: next-themes' default stands for this session and
    // the next app-start reconcile restores the mirror.
  }
}

/**
 * Drop-in replacement for next-themes' useTheme whose setter ALSO records
 * the choice durably in Dexie as an explicit guest action. All user-facing
 * theme controls must use this instead of useTheme directly.
 */
export function useAppTheme() {
  const { theme, setTheme } = useTheme();
  const setAppTheme = useCallback(
    (next: string) => {
      themeWriteCount += 1;
      setTheme(next);
      if (isAppTheme(next)) {
        void persistThemeDurably(next);
      }
    },
    [setTheme],
  );
  return { theme, setTheme: setAppTheme };
}
