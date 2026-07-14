"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  applyArabicFontScale,
  DEFAULT_ARABIC_FONT_SCALE,
  readArabicFontScale,
  writeArabicFontScale,
  type ArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";

/*
 * localStorage is an external store: subscribers are notified on same-tab
 * writes (via the local listener set) and cross-tab writes (via the
 * `storage` event). The server snapshot is the default, so SSR output is
 * hydration-safe and the stored value applies right after hydration.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): ArabicFontScale {
  return readArabicFontScale(window.localStorage);
}

function getServerSnapshot(): ArabicFontScale {
  return DEFAULT_ARABIC_FONT_SCALE;
}

export function useArabicFontScale() {
  const scale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Keep the CSS custom property in sync with the current value.
  useEffect(() => {
    applyArabicFontScale(document.documentElement, scale);
  }, [scale]);

  const setScale = useCallback((next: ArabicFontScale) => {
    writeArabicFontScale(window.localStorage, next);
    applyArabicFontScale(document.documentElement, next);
    emitChange();
  }, []);

  const reset = useCallback(() => {
    setScale(DEFAULT_ARABIC_FONT_SCALE);
  }, [setScale]);

  return { scale, setScale, reset };
}
