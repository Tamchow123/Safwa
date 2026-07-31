import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { apiRateLimits } from "@/db/schema/rate-limit";
import {
  consumeRateLimit,
  RATE_LIMIT_RULES,
} from "@/modules/sync/server/rate-limit";

/**
 * The API rate limiter, against real Postgres (Phase 18.1).
 *
 * These assertions are here rather than in the unit suite because every
 * property that matters is a property of the SQL: the atomicity of the
 * increment, the window arithmetic against the database's own `now()`, and the
 * upsert's conflict resolution. A fake would be asserting the fake.
 *
 * `api_rate_limits` has no `user_id`, so it is one of the global tables
 * `tests/integration/setup.ts` warns about — the per-user isolation trick does
 * not apply. Isolation here comes from each test using its own SUBJECT string
 * instead, which is enough because the counter's key is `<bucket>:<subject>`
 * and a unique subject is therefore a unique row.
 */

/** A subject nothing else in this file will collide with. */
let counter = 0;
function uniqueSubject(label: string): string {
  counter += 1;
  return `test-${label}-${counter}`;
}

/** Push the row's window back in time, to simulate a window that has closed. */
async function ageWindow(key: string, seconds: number): Promise<void> {
  await getDb()
    .update(apiRateLimits)
    .set({
      windowStartedAt: sql`now() - make_interval(secs => ${seconds})`,
    })
    .where(sql`${apiRateLimits.key} = ${key}`);
}

describe("consumeRateLimit", () => {
  it("allows exactly the rule's max, then refuses", async () => {
    const subject = uniqueSubject("ceiling");
    const { max } = RATE_LIMIT_RULES["account-settings"];

    for (let i = 0; i < max; i += 1) {
      const result = await consumeRateLimit("account-settings", subject);
      expect(
        result.allowed,
        `request ${i + 1} of ${max} should be allowed`,
      ).toBe(true);
    }

    const overLimit = await consumeRateLimit("account-settings", subject);
    expect(overLimit.allowed).toBe(false);
  });

  it("tells a refused caller how long to wait, in whole seconds", async () => {
    const subject = uniqueSubject("retry-after");
    const { max, windowSeconds } = RATE_LIMIT_RULES["account-settings"];

    for (let i = 0; i <= max; i += 1) {
      await consumeRateLimit("account-settings", subject);
    }
    const refused = await consumeRateLimit("account-settings", subject);

    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    // Never zero — a client honouring Retry-After must not busy-loop — and
    // never longer than the window it is waiting out.
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });

  it("opens a fresh window once the old one has closed", async () => {
    const subject = uniqueSubject("window-reset");
    const rule = RATE_LIMIT_RULES["account-settings"];

    for (let i = 0; i <= rule.max; i += 1) {
      await consumeRateLimit("account-settings", subject);
    }
    expect((await consumeRateLimit("account-settings", subject)).allowed).toBe(
      false,
    );

    // Age the window past its own duration rather than sleeping for it: the
    // behaviour under test is the SQL's comparison against now(), and waiting
    // a real minute would prove the same thing far more slowly.
    await ageWindow(`account-settings:${subject}`, rule.windowSeconds + 1);

    expect(
      (await consumeRateLimit("account-settings", subject)).allowed,
      "a closed window must admit the next caller",
    ).toBe(true);
  });

  it("counts each account separately, so one cannot exhaust another's limit", async () => {
    // The security-relevant one. A shared counter would let any account deny
    // service to every other account by spending the budget.
    const victim = uniqueSubject("victim");
    const noisy = uniqueSubject("noisy");
    const { max } = RATE_LIMIT_RULES["account-settings"];

    for (let i = 0; i <= max + 5; i += 1) {
      await consumeRateLimit("account-settings", noisy);
    }
    expect((await consumeRateLimit("account-settings", noisy)).allowed).toBe(
      false,
    );

    expect(
      (await consumeRateLimit("account-settings", victim)).allowed,
      "a different account's budget must be untouched",
    ).toBe(true);
  });

  it("counts each bucket separately, so one route cannot exhaust another", async () => {
    const subject = uniqueSubject("buckets");
    const { max } = RATE_LIMIT_RULES["account-settings"];

    for (let i = 0; i <= max + 1; i += 1) {
      await consumeRateLimit("account-settings", subject);
    }
    expect((await consumeRateLimit("account-settings", subject)).allowed).toBe(
      false,
    );

    expect(
      (await consumeRateLimit("sync-push", subject)).allowed,
      "exhausting settings must not close sync for the same account",
    ).toBe(true);
  });

  it("loses no increment when requests arrive concurrently", async () => {
    // The reason the counter is a single INSERT ... ON CONFLICT DO UPDATE
    // rather than a read followed by a write. Under a read-then-write, two
    // simultaneous requests both read N and both write N+1, so the limit
    // leaks — and it leaks precisely under the concurrency that makes a limit
    // worth having. Two devices syncing at once is the ordinary case here.
    const subject = uniqueSubject("concurrent");
    const { max } = RATE_LIMIT_RULES["account-settings"];
    const attempts = max + 20;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        consumeRateLimit("account-settings", subject),
      ),
    );

    const allowed = results.filter((r) => r.allowed).length;
    expect(
      allowed,
      `exactly ${max} of ${attempts} concurrent requests should be allowed`,
    ).toBe(max);
  });
});
