import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";

/**
 * Migration-mechanics integration suite (phases-15.md §54): applying to an
 * empty database is already implicitly proven by every other integration
 * file (tests/integration/setup.ts migrates a freshly-truncated schema
 * before each file) — this file adds the explicit assertion plus the
 * harder-to-observe "cannot partially succeed unnoticed" guarantee.
 *
 * drizzle-orm's own migrator (node_modules/drizzle-orm/pg-core/dialect.js)
 * wraps every pending migration file's statements — AND the
 * `drizzle.__drizzle_migrations` bookkeeping insert — in ONE
 * `session.transaction(...)` for the whole run: a failing statement rolls
 * back everything in that same call, including any earlier, individually
 * valid statement in the same file. This test proves that with a
 * throwaway migration folder whose one file pairs a valid `CREATE TABLE`
 * with a deliberately invalid trailing statement, and rules out the test
 * passing for the wrong reason (see the two extra checks below).
 *
 * Precondition this test relies on instead of its own locking: no OTHER
 * integration file's `beforeAll` (which also calls `migrate()` against
 * this same shared database via `resetTestDatabase()`) can run
 * concurrently with this one, because `vitest.integration.config.ts` sets
 * `fileParallelism: false`. If that setting is ever relaxed before
 * per-worker database isolation is fully wired (see that config file's own
 * documented revisit trigger), this test's direct, unlocked `migrate()`
 * call would need its own `pg_advisory_lock` too.
 */

let scratchDir: string | undefined;

afterEach(async () => {
  if (scratchDir) {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

describe("migration mechanics", () => {
  it("the current migration applies cleanly to an (already-reset) empty database", async () => {
    const db = getDb();
    const tables = await db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map(
      (row) => (row as { tablename: string }).tablename,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "accounts",
        "verifications",
        "rate_limits",
        "skill_types",
        "study_components",
        "study_sessions",
        "study_attempts",
        "review_events",
        "daily_activity",
        "bookmarks",
        "custom_lists",
        "custom_list_entries",
        "user_settings",
        "guest_imports",
        "content_versions",
      ]),
    );
  });

  it("a migration file with a failing statement cannot partially succeed", async () => {
    const db = getDb();
    const tableName = `atomicity_check_${randomUUID().replace(/-/g, "")}`;

    // Prove the CREATE TABLE half is genuinely valid SQL on its own — not
    // just "absent because the whole probe file failed to parse" — by
    // running and then rolling it back directly, independent of migrate().
    // tx.rollback() throws by design (drizzle-orm/pg-core/session.js) to
    // trigger the rollback, so db.transaction() itself rejects here — the
    // expected, intentional outcome, not a real failure.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE TABLE "${tableName}" (id integer)`));
        tx.rollback();
      }),
    ).rejects.toThrow();

    const migrationsBefore = await db.execute(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    );
    const countBefore = (migrationsBefore.rows[0] as { count: number }).count;

    scratchDir = await mkdtemp(join(tmpdir(), "safwa-migration-atomicity-"));
    await mkdir(join(scratchDir, "meta"), { recursive: true });

    const when = Date.now() + 1_000_000; // after any real migration's timestamp
    await writeFile(
      join(scratchDir, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when,
            tag: "0000_atomicity_probe",
            breakpoints: true,
          },
        ],
      }),
    );
    await writeFile(
      join(scratchDir, "0000_atomicity_probe.sql"),
      `CREATE TABLE "${tableName}" (id integer);\n--> statement-breakpoint\nTHIS IS NOT VALID SQL;\n`,
    );

    // Confirm the rejection actually names the invalid statement itself
    // (drizzle-orm's pg error wraps the failed query text verbatim) — not,
    // say, a journal-format parsing failure that would never have reached
    // (let alone attempted) the invalid statement at all, which would make
    // this test pass for a reason unrelated to the atomicity guarantee
    // it's meant to prove.
    await expect(migrate(db, { migrationsFolder: scratchDir })).rejects.toThrow(
      /THIS IS NOT VALID SQL/,
    );

    const stillMissing = await db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ${tableName}`,
    );
    expect(stillMissing.rows).toHaveLength(0);

    // The bookkeeping insert lives in the same transaction as the DDL
    // (traced in drizzle-orm/pg-core/dialect.js), so a rollback must leave
    // no orphaned row behind either — asserted explicitly rather than only
    // relied upon, so a future drizzle-orm behavior change that moved this
    // insert outside the transaction would be caught here.
    const migrationsAfter = await db.execute(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    );
    const countAfter = (migrationsAfter.rows[0] as { count: number }).count;
    expect(countAfter).toBe(countBefore);
  });
});
