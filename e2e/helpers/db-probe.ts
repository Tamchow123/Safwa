/**
 * Playwright-safe Postgres probe for the Phase 15 auth E2E suite
 * (phases-15.md §60.10 — "confirm server personal rows are gone through
 * integration helper"). Builds its own `drizzle-orm/node-postgres`
 * instance directly against a `pg.Pool`, rather than importing
 * `db/client.ts` (which is `server-only`-tagged and unusable from
 * Playwright's Node process — see e2e/global-setup.ts's docblock for the
 * same constraint). `db/schema.ts` itself carries no such marker, so the
 * real typed table definitions are used here instead of hand-written SQL
 * strings — a schema rename is caught by the type checker here exactly as
 * it would be in the Vitest integration suite, rather than only surfacing
 * as a runtime failure the next time this E2E spec happens to run.
 * Read-only: this file never writes to the database — verification only,
 * mirroring what tests/integration/account-deletion.test.ts already
 * proves via Vitest, just re-observed from the E2E side after a real
 * browser-driven deletion flow.
 */
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { E2E_DATABASE_URL } from "./e2e-server-env";

function withDb<T>(
  run: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: E2E_DATABASE_URL });
  const db = drizzle(pool, { schema });
  return run(db).finally(() => pool.end());
}

/** True if a `users` row with this email still exists. */
export function userRowExists(email: string): Promise<boolean> {
  return withDb(async (db) => {
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Total row count in the server-side `bookmarks` table. Nothing in this
 * phase writes to it (no Dexie<->Postgres sync/merge exists yet — that is
 * Phase 16+ scope), so this is used to prove local guest bookmarks were
 * never uploaded, not to look up any specific row.
 */
export function bookmarksRowCount(): Promise<number> {
  return withDb(async (db) => {
    const [row] = await db.select({ total: count() }).from(schema.bookmarks);
    return row?.total ?? 0;
  });
}
