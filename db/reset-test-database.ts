/**
 * Disposable-test-database reset (phases-15.md §63) — `pnpm db:test:reset`.
 * Used by the integration-test harness (T4+) and the local quality gate to
 * guarantee a clean, current-schema, seeded database before each run.
 *
 * Safety: refuses to run unless BOTH (a) `NODE_ENV=test` and (b) the parsed
 * database name matches `safwa_test` or `safwa_test_<worker>` exactly.
 * `safwa`, `safwa_prod`, `production`, `postgres`, `neondb` and anything
 * else are refused outright — there is no override. This module must never
 * be reachable from an HTTP route; it is a standalone CLI script only.
 *
 * Run via `tsx --conditions=react-server` (baked into the `db:test:reset`
 * script) — see db/migrate.ts's docblock for why a bare `tsx` invocation
 * cannot import this file's `server-only`-marked dependencies.
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { closeDb, getDb } from "@/db/client";
import { getServerEnv } from "@/modules/env/server";
import { seedSkillTypes } from "@/db/seed";

const TEST_DATABASE_NAME_PATTERN = /^safwa_test(_\w+)?$/;

export class UnsafeTestDatabaseError extends Error {}

/** Exported for direct unit testing of the guard logic without a live DB. */
export function assertSafeToReset(
  databaseUrl: string,
  nodeEnv: string,
): string {
  if (nodeEnv !== "test") {
    throw new UnsafeTestDatabaseError(
      `Refusing to reset a database outside NODE_ENV=test (got "${nodeEnv}").`,
    );
  }
  let databaseName: string;
  try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  } catch {
    throw new UnsafeTestDatabaseError(
      "Refusing to reset: DATABASE_URL could not be parsed.",
    );
  }
  if (!TEST_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to reset database "${databaseName}" — only names matching ` +
        `safwa_test or safwa_test_<worker> are permitted.`,
    );
  }
  return databaseName;
}

async function truncateAllTables(): Promise<void> {
  const db = getDb();
  const tables = await db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const names = tables.rows
    .map((row) => (row as { tablename: string }).tablename)
    .filter((name) => name !== "__drizzle_migrations");
  if (names.length === 0) return;
  const identifiers = names.map((name) => sql.identifier(name));
  await db.execute(
    sql`TRUNCATE TABLE ${sql.join(identifiers, sql`, `)} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Runs `fn` while holding a Postgres session-level advisory lock keyed on
 * the database name, so two processes pointed at the SAME test database
 * (a misconfigured parallel-worker setup, T4+) serialize instead of racing
 * migrate/truncate/reseed against each other. A dedicated `pg.Client` (not
 * the shared pooled `db`) holds the lock for its whole lifetime — session
 * advisory locks are tied to one physical connection, and a pool query can
 * be routed to any connection, so acquire/release must happen on the same
 * client to be meaningful.
 */
const RESET_LOCK_TIMEOUT_MS = 30_000;
const RESET_LOCK_POLL_INTERVAL_MS = 250;

/**
 * Polls `pg_try_advisory_lock` (non-blocking) instead of the blocking
 * `pg_advisory_lock`: if a prior holder was killed uncleanly (OOM-kill, a
 * CI job's own hard timeout) without a graceful disconnect, Postgres can
 * take a long time to notice the dead connection and release its lock — a
 * blocking wait would then hang this call indefinitely. A bounded poll
 * fails fast with a clear, actionable error instead.
 */
async function acquireResetLock(client: Client): Promise<void> {
  const deadline = Date.now() + RESET_LOCK_TIMEOUT_MS;
  for (;;) {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext(current_database())::bigint) AS acquired",
    );
    if (result.rows[0]?.acquired) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${RESET_LOCK_TIMEOUT_MS}ms waiting for the test-database reset lock — another process may be stuck holding it.`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RESET_LOCK_POLL_INTERVAL_MS),
    );
  }
}

async function withResetLock<T>(
  databaseUrl: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await acquireResetLock(client);
    return await fn();
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext(current_database())::bigint)",
    );
    await client.end();
  }
}

async function main(): Promise<void> {
  const env = getServerEnv();
  const databaseName = assertSafeToReset(env.databaseUrl, env.nodeEnv);
  await withResetLock(env.databaseUrl, async () => {
    const db = getDb();
    await migrate(db, { migrationsFolder: "./db/migrations" });
    await truncateAllTables();
    await seedSkillTypes(db);
  });
  console.log(`Reset and reseeded disposable test database "${databaseName}".`);
}

// Only run when executed directly (`tsx db/reset-test-database.ts`), never
// merely by being imported (e.g. a unit test importing `assertSafeToReset`).
// Compared via pathToFileURL, not a plain "file://" template-string prefix
// — process.argv[1] is a native OS path, backslash-separated on Windows,
// which would never string-equal import.meta.url's forward-slash form.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  // Dynamic, not a static top-level import — see db/migrate.ts for why.
  import("@/db/load-env")
    .then(main)
    .then(async () => {
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error("Test database reset failed:", error);
      await closeDb();
      process.exit(1);
    });
}
