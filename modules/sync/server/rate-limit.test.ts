import { describe, expect, it, vi } from "vitest";

// Scoped mock, matching grade.test.ts / release.test.ts: this module is
// `server-only`, which throws outside a react-server condition.
vi.mock("server-only", () => ({}));

// The database is mocked to FAIL for this file. Everything the limiter does
// when Postgres is reachable is proved against real Postgres in
// tests/integration/rate-limit.test.ts — including the window arithmetic and
// the atomicity of the increment, neither of which a fake could establish.
// What is left, and what this file exists for, is the one behaviour that is
// impossible to provoke against a healthy database: what happens when the
// counter itself is unavailable.
vi.mock("@/db/client", () => ({
  getDb: () => {
    throw new Error("simulated database outage");
  },
}));

import {
  consumeRateLimit,
  RATE_LIMIT_RULES,
  RATE_LIMITED_ERROR,
} from "@/modules/sync/server/rate-limit";

describe("consumeRateLimit when the counter is unavailable", () => {
  it("fails OPEN, allowing the request", async () => {
    // This is a deliberate trade-off and the reason it is pinned by a test:
    // failing closed would convert a transient database blip into a total
    // outage of study sync, which is both likelier and worse than the burst
    // that gets through while the limiter is down. The routes behind this are
    // already authenticated, so an open failure forgoes a cost ceiling — it
    // does not expose anything. Anyone inverting this should have to delete
    // this test and read why first.
    const result = await consumeRateLimit("sync-push", "any-account");
    expect(result.allowed).toBe(true);
  });

  it("does not put account data in the log line it writes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await consumeRateLimit("account-settings", "account-id-9f3e");
      expect(error).toHaveBeenCalled();
      const logged = error.mock.calls.flat().join(" ");
      // The subject is an opaque account id and must not be echoed into logs
      // that ship off-device; the bucket name alone is enough to diagnose.
      expect(logged).not.toContain("account-id-9f3e");
    } finally {
      error.mockRestore();
    }
  });
});

describe("the rate limit rules", () => {
  it("gives every bucket a positive ceiling and a positive window", () => {
    for (const [bucket, rule] of Object.entries(RATE_LIMIT_RULES)) {
      expect(rule.max, `${bucket} max`).toBeGreaterThan(0);
      expect(rule.windowSeconds, `${bucket} window`).toBeGreaterThan(0);
    }
  });

  it("clears a whole chunked guest merge, which is many requests", () => {
    // The merge is staged and chunked, so one legitimate merge is far more
    // than one request. A ceiling below that would break the feature it is
    // meant to protect — and it would do so only for the learners with the
    // most guest history to bring, which is the worst possible failure
    // distribution.
    expect(RATE_LIMIT_RULES["guest-merge"].max).toBeGreaterThan(
      RATE_LIMIT_RULES["sync-push"].max,
    );
  });

  it("keeps the refusal message free of anything caller-specific", () => {
    expect(RATE_LIMITED_ERROR).not.toMatch(/\d/);
  });
});
