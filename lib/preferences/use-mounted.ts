"use client";

import { useSyncExternalStore } from "react";

/** Never fires — hydration gating only needs the two static snapshots. */
function subscribeNoop(): () => void {
  return () => {};
}

/**
 * True after hydration; the server AND the first client (hydration) render
 * both see false, so environment-derived markup gated on this can never
 * cause a hydration mismatch. The ONE mounted gate — components must not
 * carry their own copies (used by the theme selector's pressed state and
 * the timezone picker's Intl-derived zone list/label).
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}
