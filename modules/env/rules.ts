/**
 * The parts of the server environment contract that must be readable WITHOUT a
 * valid environment, and without `server-only`.
 *
 * `modules/env/server.ts` owns validation, but it carries `server-only` and
 * validates lazily on first use — right for the app, wrong for a deploy, since
 * by the time lazy validation runs the deployment already exists.
 * `scripts/verify-deploy-preconditions.ts` checks the same contract in plain
 * Node before anything ships. Every rule both of them need lives here, once, so
 * the build-time gate and the runtime validator cannot drift apart and quietly
 * disagree about what a valid production configuration is.
 *
 * Nothing here may gain a dependency, a `server-only` marker, or a side effect.
 * It is imported by a script whose whole job is to run in the situation it
 * exists to diagnose.
 */

/**
 * Production bounds on the four rate-limit tuning variables (Phase 18).
 *
 * `docs/DEPLOYMENT.md` §2 has warned since Phase 15 that these were validated
 * only for positivity, and that copying an E2E- or CI-tuned `.env` into
 * production would "silently and drastically weaken rate limiting with no
 * validation error to catch it at deploy time". `e2e/helpers/e2e-server-env.ts`
 * really does set `AUTH_RATE_LIMIT_DEFAULT_MAX=100000` and
 * `AUTH_RATE_LIMIT_MAX=1000`; these bounds make both structurally unreachable
 * in production rather than merely discouraged in prose.
 *
 * The two MAX ceilings are the security-relevant ones. The window bounds are a
 * pair of sanity limits, and it is worth being precise about which risk each
 * one addresses, because they are not the same risk:
 *  - the FLOOR is security: a one-second window makes any max meaningless,
 *    because the bucket empties faster than an attacker can be slowed down.
 *  - the CEILING is availability: an hour-long window means one fat-fingered
 *    burst locks the instance's only learner out until it expires.
 */
export const PRODUCTION_RATE_LIMIT_BOUNDS = {
  /** Sensitive endpoints (sign-in, sign-up, reset, delete). Default is 5. */
  AUTH_RATE_LIMIT_MAX: { min: 1, max: 20 },
  AUTH_RATE_LIMIT_WINDOW_SECONDS: { min: 30, max: 3600 },
  /**
   * The default bucket covers get-session and friends — read-mostly, hit on
   * every page mount, not brute-forceable — so it legitimately needs far more
   * headroom than the sensitive rules. Better Auth's own default is 100/10s;
   * 1000 leaves room for a busy real session while refusing the E2E 100000.
   */
  AUTH_RATE_LIMIT_DEFAULT_MAX: { min: 1, max: 1000 },
  AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: { min: 5, max: 3600 },
} as const;

export type RateLimitVariable = keyof typeof PRODUCTION_RATE_LIMIT_BOUNDS;

/** Below this a signing secret is guessable enough to matter. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** The schemes a Postgres connection string may use. */
export const POSTGRES_URL_PREFIXES = ["postgres://", "postgresql://"] as const;

export function looksLikePostgresUrl(value: string): boolean {
  return POSTGRES_URL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * How this app reads a boolean environment variable, in one place.
 *
 * `TRUE`, ` true ` and `True` all mean true; anything else that is not exactly
 * `false` is not a boolean at all and the caller decides what to do about it.
 * Returns `undefined` for "no opinion" — an unset, blank, or unrecognised
 * value — so a validator can apply a default and a pre-deploy check can report
 * a typo rather than silently treating `treu` as false.
 *
 * This exists because the two consumers disagreed once already: a stricter
 * comparison in the deploy script let `SYNC_ENABLED=TRUE` pass a check that the
 * runtime then failed at boot, which is precisely the "found late" outcome the
 * script is meant to prevent.
 */
export function normaliseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised === "true") return true;
  if (normalised === "false") return false;
  return undefined;
}
