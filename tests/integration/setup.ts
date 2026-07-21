import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, vi } from "vitest";

// Scoped to the integration run only: Vitest resolves the package's
// default export condition (throws by design), not the `react-server`
// condition Next.js's build resolves to an empty module.
vi.mock("server-only", () => ({}));

// Local dev convenience only — CI sets DATABASE_URL/etc. directly.
loadEnv({ path: ".env.local" });

import { closeDb } from "@/db/client";
import { resetTestDatabase } from "@/db/reset-test-database";

// One full reset per test FILE (this setup file's beforeAll/afterAll runs
// per file, and fileParallelism:false in vitest.integration.config.ts keeps
// files from resetting the shared database out from under each other).
// Tests within a file are responsible for their own isolation — typically
// by inserting a fresh user per test, since MOST application tables scope
// their uniqueness to user_id (see docs/TEST_STRATEGY.md §6).
//
// EXCEPTION — global/lookup tables with no user_id column at all
// (currently: content_versions, skill_types): the per-user trick does not
// isolate these. A file touching one of them must express every
// constraint/uniqueness assertion for that table as ONE test (see
// tests/integration/settings-and-content.test.ts's content_versions
// describe block for the pattern), not split across multiple `it()`
// blocks that could collide on rows an earlier test in the same file left
// behind.
//
// resetTestDatabase() re-runs migrate()'s journal comparison on every file,
// not just once for the whole run — negligible at today's file count;
// revisit (hoist migrate() into a Vitest globalSetup, leaving only
// truncate+reseed per file) only if that overhead becomes measurable as
// more integration files are added.
beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeDb();
});
