"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

import {
  reconcileThemeFromDb,
  watchThemeMirrorRemoval,
} from "@/lib/preferences/use-app-theme";

/**
 * Reconciles the durable (Dexie) theme with next-themes' localStorage
 * mirror at app start: restores a cleared mirror from Dexie and migrates a
 * mirror-only value into Dexie. Also watches for the mirror KEY being
 * removed by another tab, which next-themes answers by writing its default
 * back — the durable value is restored over that write-back so the choice
 * survives. Renders nothing. The synchronous first paint is handled by
 * next-themes' own inline script, so there is no flash for the common case
 * where the mirror is intact.
 */
export function ThemeInitializer() {
  const { setTheme } = useTheme();

  useEffect(() => {
    void reconcileThemeFromDb(setTheme);
    return watchThemeMirrorRemoval(setTheme);
  }, [setTheme]);

  return null;
}
