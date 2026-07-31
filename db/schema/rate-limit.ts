/**
 * API rate-limit counters (Phase 18.1, migration 0007).
 *
 * WHY THIS IS NOT BETTER AUTH'S `rate_limits` TABLE, which already exists and
 * has almost exactly this shape:
 *
 * Better Auth prunes that table itself. Its rate limiter runs a background
 * `deleteMany` whose only predicate is `lastRequest < cutoff`, where the cutoff
 * derives from ITS OWN configured windows — there is no key filter, so it
 * deletes every row it finds, including rows it did not write. Verified by
 * reading the installed package rather than inferred from docs:
 * `node_modules/better-auth/dist/api/rate-limiter/index.mjs` (v1.6.23),
 * `deleteExpiredRows` — `db.deleteMany({ model, where: [{ field: "lastRequest",
 * operator: "lt", value: cutoff }] })`. Re-check this on a major upgrade; if it
 * ever gains a key filter, sharing one table becomes an option again. Borrowing the
 * table would therefore mean this limiter's counters silently reset on a
 * schedule set by a different component's configuration. A rate limit that
 * quietly stops counting is worse than none, because it still reads as a
 * control that is present.
 *
 * A fixed window, not a sliding one or a token bucket. A fixed window admits a
 * burst of up to 2x the limit across a boundary, which is a real and accepted
 * imprecision: the purpose here is to bound sustained cost from an
 * authenticated client, not to smooth traffic. The whole counter is one atomic
 * INSERT ... ON CONFLICT DO UPDATE (see modules/http/rate-limit.ts), so
 * concurrent requests from two devices cannot lose an increment between a read
 * and a write — which a sliding window over a request log would have made
 * considerably harder to guarantee.
 *
 * There is no `userId` foreign key, deliberately. The subject of a limit is a
 * KEY, not necessarily an account: the key is built by the caller and is
 * `<bucket>:<subject>`. Keeping it an opaque string means an unauthenticated
 * bucket could be added later without a migration, and it avoids a cascade
 * delete racing a counter update. Rows are pruned by age instead, by whoever
 * writes next — see the module's `pruneExpired`.
 */
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const apiRateLimits = pgTable(
  "api_rate_limits",
  {
    /**
     * `<bucket>:<subject>` — e.g. `sync-push:9f3e...`. The primary key, so the
     * upsert that increments a counter needs no separate uniqueness guarantee
     * and cannot race itself.
     */
    key: text("key").primaryKey(),
    /** Requests counted so far in the CURRENT window. */
    count: integer("count").notNull(),
    /**
     * When the current window opened. The window has expired when this is
     * older than the rule's own duration — evaluated in SQL against `now()`,
     * never against a clock the client can influence.
     */
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    // Supports the age-based prune. Without it, pruning degrades to a full
    // scan of a table every limited request writes to.
    index("api_rate_limits_window_started_idx").on(table.windowStartedAt),
  ],
);
