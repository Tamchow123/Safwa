"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * Whether the user has requested reduced motion. Hydration-safe: SSR and the
 * first client render both return false, and the live value is read after mount
 * via `matchMedia`, so the flashcard can drop its flip/swipe animation without a
 * hydration mismatch. Global CSS already neutralises decorative transitions;
 * this hook lets a component render a structurally different (non-transform)
 * variant where that matters.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
