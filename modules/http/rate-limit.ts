/**
 * Phase 18.1 — rate limiting for the API routes Better Auth does not cover.
 *
 * Better Auth rate-limits its own endpoints (sign-in, sign-up, password reset,
 * delete-user and the rest) through `modules/auth/server.ts`. It knows nothing
 * about this app's own routes, so `/api/sync/push`, `/api/sync/pull`,
 * `/api/sync/guest-merge` and `/api/account/settings` had no limit at all —
 * every one of them authenticated, and the sync routes accepting batches whose
 * worst case is a long transaction per request.
 *
 * WHAT THIS DEFENDS AND WHAT IT DOES NOT. Signup is allowlist-gated, so an
 * attacker cannot mint accounts to get here; reaching these routes requires a
 * session on a verified account. The realistic threats are therefore a stolen
 * session, a buggy client stuck in a resend loop, and the learner's own device
 * doing something pathological — all of which are cost and availability
 * problems rather than confidentiality ones. That is why the limits below are
 * generous enough that no legitimate client should ever meet them: this is a
 * ceiling on runaway cost, not an attempt to shape normal traffic.
 *
 * KEYED BY ACCOUNT, NOT BY IP. The user id comes from the server session, so it
 * cannot be spoofed, whereas a client-supplied forwarded-for header can be.
 * IP keying would also punish a shared NAT and do nothing about the case that
 * actually matters here, which is one account's client misbehaving. The cost of
 * this choice is stated plainly: it does not limit an UNAUTHENTICATED flood,
 * because these routes reject those before reaching this code.
 */
import "server-only";

import { sql } from "drizzle-orm";
import { after } from "next/server";

import { getDb } from "@/db/client";
import { apiRateLimits } from "@/db/schema/rate-limit";
import { withTimeout } from "@/lib/with-timeout";

/**
 * The refusal a limited caller sees. Fixed and generic, like every other error
 * these routes return: it says what happened and nothing about who else is
 * using the account, what the ceiling is, or how close the caller got.
 */
export const RATE_LIMITED_ERROR = "Too many requests. Please retry shortly.";

/** A limit rule: at most `max` requests per `windowSeconds`. */
export type RateLimitRule = {
  readonly max: number;
  readonly windowSeconds: number;
};

/** The outcome. `retryAfterSeconds` is only meaningful when not allowed. */
export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * The buckets, and why each number is what it is.
 *
 * These are per account, per window. A normal client syncs on a debounce after
 * study activity and on reconnect — single digits per minute even under heavy
 * use. Every ceiling below is an order of magnitude above that, so meeting one
 * is evidence of a loop or an attack rather than an eager learner.
 */
export const RATE_LIMIT_RULES = {
  /** Writes. The most expensive route: batches, replay, an advisory lock. */
  "sync-push": { max: 120, windowSeconds: 60 },
  /** Reads. Cheaper than push and legitimately paginated, so a higher ceiling. */
  "sync-pull": { max: 240, windowSeconds: 60 },
  /**
   * The merge is a staged, chunked upload, so a single legitimate merge is
   * MANY requests — the ceiling has to clear a whole merge comfortably or it
   * would break the feature it protects. Sized against
   * `SYNC_BOUNDS.maxItemsPerBatch` items per chunk: a merge far larger than
   * any real guest history still fits well inside this.
   */
  "guest-merge": { max: 300, windowSeconds: 60 },
  /** Settings writes are user-initiated form submissions. Nothing needs many. */
  "account-settings": { max: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMIT_RULES;

/**
 * How long a row outlives its window before the opportunistic prune may remove
 * it. Comfortably longer than the longest window above, so pruning can never
 * delete a row that is still counting.
 */
const PRUNE_AFTER_SECONDS = 3600;

/** Prune runs on roughly this share of calls — see `consumeRateLimit`. */
const PRUNE_PROBABILITY = 0.01;

/**
 * How long the counter's own query may take before it is treated as
 * unavailable.
 *
 * Deliberately far below the pool's 10s `statement_timeout` (db/client.ts).
 * This bound exists for the SLOW database, not the dead one: the pool's
 * timeout already covers the latter, and waiting it out on every request is
 * the failure this number prevents. A few hundred milliseconds is generous for
 * a single-row upsert on an indexed primary key; anything slower means the
 * database is in trouble, and in that state the right move is to stop asking it
 * for a cost ceiling and get on with the request.
 */
const RATE_LIMIT_TIMEOUT_MS = 500;

/**
 * Count one request against `bucket` for `subject`, and say whether it may
 * proceed.
 *
 * The counter is a SINGLE statement. That is the whole reason this is correct
 * under concurrency: read-then-write would let two simultaneous requests from
 * two devices both read count=N and both write N+1, losing an increment every
 * time it happened — precisely under the load where the limit matters. Here,
 * Postgres resolves the conflict on the primary key and the CASE decides,
 * inside the same statement, whether this request opens a new window or joins
 * the current one. `now()` is the database's clock throughout; no timestamp
 * from the client or from this process is trusted.
 *
 * FAILS OPEN, deliberately, AND FAILS OPEN FAST. If the database is
 * unreachable the request is allowed rather than refused: failing closed would
 * turn a transient database blip into a total outage of study sync, which is a
 * bigger and likelier harm than the burst that gets through while the limiter
 * is unavailable. The routes this guards are already authenticated, so an open
 * failure does not expose anything; it only forgoes a cost ceiling.
 *
 * "Fast" is the half the first version of this file got wrong, and the phase
 * council caught. The pool's `statement_timeout` is 10s (db/client.ts), so a
 * database that is SLOW rather than DOWN would have stalled every request on
 * all four routes for up to ten seconds before failing open — adding a latency
 * tax precisely during the degradation where the app most needs to stay
 * responsive, and eating a sixth of the 60s budget the routes were given for
 * their real work. The limiter therefore races its own short deadline: a
 * counter that cannot answer promptly is treated exactly like one that cannot
 * answer at all.
 *
 * Both behaviours are asserted by tests so neither can be quietly inverted.
 */
export async function consumeRateLimit(
  bucket: RateLimitBucket,
  subject: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMIT_RULES[bucket];
  const key = `${bucket}:${subject}`;
  const windowInterval = sql`make_interval(secs => ${rule.windowSeconds})`;

  try {
    const counted = getDb()
      .insert(apiRateLimits)
      .values({ key, count: 1 })
      .onConflictDoUpdate({
        target: apiRateLimits.key,
        set: {
          count: sql`CASE
            WHEN ${apiRateLimits.windowStartedAt} < now() - ${windowInterval}
            THEN 1
            ELSE ${apiRateLimits.count} + 1
          END`,
          windowStartedAt: sql`CASE
            WHEN ${apiRateLimits.windowStartedAt} < now() - ${windowInterval}
            THEN now()
            ELSE ${apiRateLimits.windowStartedAt}
          END`,
        },
      })
      .returning({
        count: apiRateLimits.count,
        // Seconds until the current window closes, computed by the database so
        // this process's clock never enters the answer.
        retryAfter: sql<number>`GREATEST(
          0,
          CEIL(EXTRACT(EPOCH FROM (
            ${apiRateLimits.windowStartedAt} + ${windowInterval} - now()
          )))
        )::int`,
      });

    // `withTimeout` cannot cancel the query — the statement may still land
    // afterwards. That is harmless here, and is the reason this counter is
    // shaped as an idempotent single-statement upsert rather than a
    // read-then-write: a late increment against a key that owns its own row
    // either counts once or resets its own window, and nothing else in the
    // system reads this table. (Contrast lib/with-timeout.ts's own warning
    // about appending to an authoritative log — this is not that.)
    const rows = await withTimeout(
      counted,
      RATE_LIMIT_TIMEOUT_MS,
      "rate limit",
    );

    const row = rows[0];
    if (row === undefined) return { allowed: true };

    maybePrune();

    if (row.count > rule.max) {
      // At least a second, so a client honouring Retry-After never busy-loops
      // on a zero it rounded down to.
      return { allowed: false, retryAfterSeconds: Math.max(1, row.retryAfter) };
    }
    return { allowed: true };
  } catch (cause) {
    // No user or account data in this log line — the key is a bucket name and
    // an opaque id, and neither the request body nor the session is in scope.
    console.error("[rate-limit] counter unavailable, allowing request", cause);
    return { allowed: true };
  }
}

/**
 * Occasionally drop rows whose window closed long ago.
 *
 * Probabilistic rather than scheduled because this app has no cron surface a
 * serverless function can rely on, and rather than every-request because the
 * delete would then cost more than the counter it maintains.
 *
 * Registered with `after()` rather than left as a bare fire-and-forget
 * promise. Work that is on no await chain and unregistered can be frozen or
 * killed the moment the response is sent, so the first version of this would
 * mostly not have run at all — a prune that silently never prunes. This repo
 * already had the right pattern for exactly this situation in
 * `modules/email/dispatch.ts`; this now matches it, including tolerating a
 * call outside a request scope.
 *
 * Still best-effort by design: a prune failure must never affect the request
 * that triggered it, and nothing depends on it succeeding. The table is
 * bounded by (bucket × account) regardless, and an unpruned expired row is
 * reset by its own next writer through the CASE above.
 *
 * Exported for tests: the 1% probability makes it unreachable from
 * `consumeRateLimit` in a deterministic test, and a prune whose predicate is
 * wrong fails silently by construction.
 */
export function pruneExpiredRateLimits(): Promise<void> {
  return getDb()
    .delete(apiRateLimits)
    .where(
      sql`${apiRateLimits.windowStartedAt} < now() - make_interval(secs => ${PRUNE_AFTER_SECONDS})`,
    )
    .then(() => undefined)
    .catch(() => {
      // Best effort. The table is tiny and the next writer will try again.
    });
}

function maybePrune(): void {
  if (Math.random() >= PRUNE_PROBABILITY) return;
  const pruned = pruneExpiredRateLimits();
  try {
    after(() => pruned);
  } catch {
    // Called outside a request scope (a test, a script). The promise is
    // already running and already swallows its own rejection.
  }
}
