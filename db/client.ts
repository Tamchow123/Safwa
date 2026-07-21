/**
 * One reusable, lazily-initialised Postgres pool/Drizzle instance per
 * process (Phase 15). Server-only; never connects merely by being imported
 * (guest routes must render without touching Postgres at all). The
 * `globalThis` stash survives Next.js dev-mode module reloads, avoiding a
 * new pool per hot reload — the same pattern this ecosystem uses for
 * Prisma's dev singleton.
 */
import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { getServerEnv } from "@/modules/env/server";

export type Database = NodePgDatabase<typeof schema>;

const SSL_REQUIRED_PATTERN = /sslmode=(require|verify-full|verify-ca)/i;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const QUERY_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 10_000;
// Deliberately conservative for a serverless deployment target (Vercel Node
// functions): each concurrently-warm instance holds its own pool, so a
// per-instance ceiling this low keeps aggregate connections against Neon's
// pooled endpoint bounded even under many concurrent warm instances.
const MAX_POOL_CONNECTIONS = 5;

type GlobalDbStash = {
  safwaPool?: Pool;
  safwaDb?: Database;
};

const stash = globalThis as unknown as GlobalDbStash;

/**
 * Require TLS for production, for an explicit `sslmode=require|verify-full|
 * verify-ca` connection string, and — the fail-safe default — for any host
 * that isn't loopback. A bare connection string pointed at a real remote
 * Postgres (e.g. a Neon branch used from local dev) must never silently
 * negotiate plaintext just because NODE_ENV isn't "production" and the URL
 * happened to omit an explicit sslmode.
 */
export function requiresSsl(
  databaseUrl: string,
  isProduction: boolean,
): boolean {
  if (isProduction || SSL_REQUIRED_PATTERN.test(databaseUrl)) return true;
  try {
    return !LOOPBACK_HOSTNAMES.has(new URL(databaseUrl).hostname);
  } catch {
    return true;
  }
}

function createPool(): Pool {
  const env = getServerEnv();
  const isProduction = env.nodeEnv === "production";
  return new Pool({
    connectionString: env.databaseUrl,
    // Never disable certificate verification in production — only the
    // presence of TLS is environment-dependent, never its strictness.
    ssl: requiresSsl(env.databaseUrl, isProduction)
      ? { rejectUnauthorized: true }
      : undefined,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    max: MAX_POOL_CONNECTIONS,
  });
}

function getPool(): Pool {
  if (!stash.safwaPool) {
    stash.safwaPool = createPool();
  }
  return stash.safwaPool;
}

/** The shared Drizzle instance. Lazy: no connection attempt until first call. */
export function getDb(): Database {
  if (!stash.safwaDb) {
    stash.safwaDb = drizzle(getPool(), { schema });
  }
  return stash.safwaDb;
}

/**
 * Explicit shutdown for integration tests and graceful process exit. Clears
 * the stash BEFORE awaiting `pool.end()` so a concurrent `getDb()` call
 * during teardown always observes either the still-open pool or a freshly
 * created one — never a half-closed pool caught mid-drain.
 */
export async function closeDb(): Promise<void> {
  const pool = stash.safwaPool;
  if (!pool) return;
  stash.safwaPool = undefined;
  stash.safwaDb = undefined;
  await pool.end();
}
