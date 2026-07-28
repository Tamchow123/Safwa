import { APP_THEME_STORAGE_KEY } from "@/lib/preferences/app-theme";
import { ARABIC_FONT_SCALE_STORAGE_KEY } from "@/lib/preferences/arabic-font-scale";
import { withTimeout } from "@/lib/with-timeout";
import { authClient, signOut } from "@/modules/auth/client";
import { getSafwaDb } from "@/modules/content/db";
import { clearAccountLocalState } from "@/modules/sync/client/logout";

/**
 * THE single sign-out implementation (Phase 16 §18, SEC-002-T15d; Phase 17 §11).
 * End the server session, then remove the departing account's local state
 * (Dexie) AND the non-Dexie UI-preference mirrors, so a shared device never
 * leaks account A's data to the next account.
 *
 * EVERY sign-out UI must call this — never bare `signOut()` — so no entry point
 * (the /account page button, the global header dropdown, or any future one) can
 * silently forget the cleanup. This is the ONE place that class of gap can be
 * fixed or reintroduced.
 *
 * The departing account id is needed BEFORE the session ends, because the
 * cleanup is owner-scoped now (§11): it removes that account's rows and leaves a
 * coexisting GUEST's rows intact, so "Not now → sign out → keep studying as a
 * guest" no longer costs the learner their progress. If the id cannot be
 * resolved (the session was already gone), `clearAccountLocalState` falls back
 * to removing every non-guest owner's rows, so confidentiality never depends on
 * that lookup succeeding.
 *
 * The cleanup runs AFTER the server session is gone and is BEST-EFFORT: a
 * failure here must never block sign-out — the authoritative session is already
 * ended, and the next account's own sync/reload also self-heals. The Dexie side
 * is unit-tested in modules/sync/client/logout.test.ts.
 */

/**
 * How long the fallback session lookup may take before sign-out proceeds
 * without a departing id (and the cleanup sweeps every account owner instead).
 * Sign-out must never wait on the network.
 */
const SESSION_LOOKUP_TIMEOUT_MS = 2_000;
export async function signOutAndClearLocalState(
  departing: string | null = null,
): Promise<void> {
  // Callers pass the id they already hold. When they cannot, fall back to a
  // session read that is RACED against a short timeout: sign-out must never
  // wait on the network, and an unresolved id is not a correctness problem —
  // `clearAccountLocalState` then sweeps every account owner instead.
  let resolved = departing;
  if (resolved === null) {
    try {
      resolved = await withTimeout(
        authClient
          .getSession()
          .then((session) => session.data?.user?.id ?? null),
        SESSION_LOOKUP_TIMEOUT_MS,
        "sign-out session lookup",
      );
    } catch {
      resolved = null;
    }
  }
  await signOut();
  try {
    await clearAccountLocalState(getSafwaDb(), resolved);
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
