import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The SLOW database, which is a different failure from the dead one and needs
 * its own mock — hence its own file rather than another case in
 * rate-limit.test.ts, where `getDb` throws synchronously.
 *
 * This is the failure the phase council weighted most heavily. The pool's
 * `statement_timeout` is 10s (db/client.ts). Before the limiter had a deadline
 * of its own, a database that was merely struggling — not down — would have
 * added up to ten seconds to EVERY request on four routes before failing open,
 * which is a latency tax applied exactly when the app can least afford one, and
 * a sixth of the 60s budget those routes were given for their real work.
 *
 * The query here never settles at all, which is the worst case and also the
 * simplest to reason about: if the limiter waits for it, the test times out.
 */
const neverSettles = new Promise<never>(() => {});

vi.mock("@/db/client", () => ({
  getDb: () => ({
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => neverSettles,
        }),
      }),
    }),
  }),
}));

import { consumeRateLimit } from "@/modules/http/rate-limit";

describe("consumeRateLimit when the counter is slow rather than down", () => {
  it("gives up quickly and allows the request", async () => {
    const started = Date.now();
    const result = await consumeRateLimit("sync-push", "any-account");
    const elapsed = Date.now() - started;

    expect(result.allowed).toBe(true);
    // Generous relative to the 500ms budget so this cannot flake on a loaded
    // machine, but far below the 10s pool timeout it exists to avoid — the
    // assertion still fails loudly if the deadline is ever removed.
    expect(
      elapsed,
      "the limiter must not wait out the pool's statement_timeout",
    ).toBeLessThan(3000);
  });

  it("does not report the caller as limited when it gave up", async () => {
    // Fail-OPEN, not fail-closed: a slow database must not start refusing
    // legitimate traffic. This is the same decision as the outage case, and it
    // is pinned separately here because the code path is different.
    const result = await consumeRateLimit("account-settings", "any-account");
    expect(result).toEqual({ allowed: true });
  });
});
