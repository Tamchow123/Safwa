/**
 * Client-safe environment values (Phase 15). Only `NEXT_PUBLIC_*` variables
 * belong here — Next.js inlines them into the client bundle at build time,
 * so `process.env.NEXT_PUBLIC_APP_URL` must appear literally (not through a
 * dynamic lookup) for that replacement to work. Never add a secret here.
 */
import { z } from "zod";

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url("NEXT_PUBLIC_APP_URL must be a valid URL")
    .optional(),
  NEXT_PUBLIC_SW_ENABLED: z.string().optional(),
});

export type ClientEnv = {
  appUrl: string | undefined;
  /**
   * Whether this build should register the service worker (Phase 18, slice 11).
   * `false` does not merely skip registration — it actively unregisters and
   * clears the caches. See {@link resolveServiceWorkerEnabled}.
   */
  serviceWorkerEnabled: boolean;
};

/**
 * The three states `NEXT_PUBLIC_SW_ENABLED` can be in, and why it is a
 * tri-state rather than a boolean with a default.
 *
 * - `"false"` — **off, and actively so.** The provider unregisters every
 *   worker for this scope and deletes every cache it owns. This is the whole
 *   substance of `docs/DEPLOYMENT.md` §8's "unregister SW" rollback: a
 *   service worker outlives a redeploy, so a build that merely stopped calling
 *   `register()` would leave the old worker in place and in control forever.
 *   Only a build that says `false` out loud can undo one.
 * - `"true"` — **on, regardless of build mode.** Needed because the offline E2E
 *   config (slice 12) is the one place a worker must run outside an ordinary
 *   production deploy.
 * - unset — **on in a production build, off otherwise.** Off is the right
 *   default for `next dev`: the four Playwright configs that predate this phase
 *   run without a worker, and a worker appearing under them would change what
 *   they test without anyone asking for it. `@serwist/turbopack` also leaves the
 *   precache manifest as an unreplaced placeholder in development, so a worker
 *   registered there would be a different worker from the one that ships.
 *
 * Anything else — a typo, `"0"`, `"no"` — is treated as unset rather than as
 * off. Silently disabling the entire offline capability because a variable was
 * misspelled is the worse failure, and it is invisible: the app keeps working
 * online.
 */
export function resolveServiceWorkerEnabled(
  raw: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  if (raw === "false") return false;
  if (raw === "true") return true;
  return nodeEnv === "production";
}

const parsed = clientEnvSchema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  // Both sides read literally, not through a dynamic lookup: Next replaces
  // `process.env.NEXT_PUBLIC_*` and `process.env.NODE_ENV` textually at build
  // time, and a computed key would survive into the bundle as a lookup against
  // an object that does not exist in a browser.
  NEXT_PUBLIC_SW_ENABLED: process.env.NEXT_PUBLIC_SW_ENABLED,
});

export const clientEnv: ClientEnv = {
  appUrl: parsed.NEXT_PUBLIC_APP_URL,
  serviceWorkerEnabled: resolveServiceWorkerEnabled(
    parsed.NEXT_PUBLIC_SW_ENABLED,
    process.env.NODE_ENV,
  ),
};
