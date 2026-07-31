import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SYNC_BOUNDS } from "@/modules/sync/protocol";

/**
 * Every sync route declares its own time budget (Phase 18.1).
 *
 * Vercel's default for a Node.js function is 10 seconds. These three routes
 * accept batches — up to `SYNC_BOUNDS.maxItemsPerBatch` items for guest-merge
 * — whose worst case is a long sequence of per-item queries inside one
 * advisory-locked transaction. When the platform kills such a request, nothing
 * corrupts: Postgres rolls the transaction back. What happens instead is worse
 * to diagnose, because it is invisible from the server: the client's
 * orchestrator classifies a killed function as a retryable network fault and
 * resends the SAME batch, which dies the same way, forever. Sync stops, and it
 * presents as bad connectivity.
 *
 * These assertions read the route SOURCE rather than importing the modules,
 * and that is deliberate on two counts. The routes import `server-only`, which
 * throws outside a react-server condition, so importing them here is not
 * possible. More importantly, Next reads route segment config by STATIC
 * ANALYSIS — a value that arrives through an import or a computation is
 * ignored rather than applied. Asserting the literal text is therefore a
 * closer match to what the platform actually does than asserting the runtime
 * value would be: a refactor that hoisted these into a shared constant would
 * typecheck, keep the same runtime value, silently stop taking effect, and
 * fail this test.
 */
const ROUTES = [
  "app/api/sync/push/route.ts",
  "app/api/sync/pull/route.ts",
  "app/api/sync/guest-merge/route.ts",
] as const;

/**
 * The ceiling on Vercel's Hobby plan, and therefore valid on every plan above
 * it. Chosen so the value does not silently become invalid if the deployment
 * target's plan changes — a limit above the plan's maximum is a deploy-time
 * error, which is a bad way to find out.
 */
const EXPECTED_MAX_DURATION = 60;

function sourceOf(route: string): string {
  return readFileSync(join(process.cwd(), route), "utf8");
}

describe("the sync routes' time budgets", () => {
  it.each(ROUTES)("%s declares maxDuration as a static literal", (route) => {
    // Anchored to the line start so a mention inside a comment cannot satisfy
    // it — the export itself has to be there.
    expect(sourceOf(route)).toMatch(
      new RegExp(`^export const maxDuration = ${EXPECTED_MAX_DURATION};$`, "m"),
    );
  });

  it("keeps every route on the same budget, so none is the weak one", () => {
    const declared = ROUTES.map((route) => {
      const match = /^export const maxDuration = (\d+);$/m.exec(
        sourceOf(route),
      );
      return match?.[1];
    });
    expect(new Set(declared)).toEqual(new Set([String(EXPECTED_MAX_DURATION)]));
  });

  it("budgets more than a second per accepted item at the largest bound", () => {
    // The point of the budget is that it is proportionate to what the routes
    // AGREE to accept. If a future change raised the batch bound far beyond
    // what 60s can service, the poison-batch loop would return with the same
    // symptoms, so the two numbers are tied together here rather than left to
    // drift independently.
    expect(SYNC_BOUNDS.maxItemsPerBatch).toBeLessThanOrEqual(
      EXPECTED_MAX_DURATION * 1000,
    );
  });
});
