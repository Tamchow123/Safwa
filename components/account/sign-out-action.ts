import { APP_THEME_STORAGE_KEY } from "@/lib/preferences/app-theme";
import { ARABIC_FONT_SCALE_STORAGE_KEY } from "@/lib/preferences/arabic-font-scale";
import { signOut } from "@/modules/auth/client";
import { getSafwaDb } from "@/modules/content/db";
import { clearAccountLocalState } from "@/modules/sync/client/logout";

/**
 * THE single sign-out implementation (Phase 16 §18, SEC-002-T15d). End the
 * server session, then wipe the previous account's synced local state (Dexie)
 * AND the non-Dexie UI-preference mirrors, so a shared device never leaks
 * account A's data to the next account.
 *
 * EVERY sign-out UI must call this — never bare `signOut()` — so no entry point
 * (the /account page button, the global header dropdown, or any future one) can
 * silently forget the wipe. This is the ONE place that class of gap can be
 * fixed or reintroduced.
 *
 * The wipe runs AFTER the server session is gone and is BEST-EFFORT: a failure
 * here must never block sign-out — the authoritative session is already ended,
 * and the next account's own sync/reload also self-heals. The Dexie wipe itself
 * is unit-tested in modules/sync/client/logout.test.ts.
 */
export async function signOutAndClearLocalState(): Promise<void> {
  await signOut();
  try {
    await clearAccountLocalState(getSafwaDb());
  } catch {
    // Local clear is best-effort; the authoritative session is already ended.
  }
  // Also drop the non-Dexie UI-preference mirrors (theme, font scale) so the
  // next account starts from defaults rather than inheriting A's cosmetics.
  try {
    localStorage.removeItem(APP_THEME_STORAGE_KEY);
    localStorage.removeItem(ARABIC_FONT_SCALE_STORAGE_KEY);
  } catch {
    // No localStorage (private mode / SSR) — nothing to clear.
  }
}
