/**
 * Health endpoint (Phase 15, phases-15.md §52) at `/api/health`. Reports
 * only non-sensitive status: never a DB connection string, environment
 * variable, or stack trace. Every check is bounded by a timeout so a
 * stalled dependency degrades this endpoint to "unhealthy" rather than
 * hanging the request indefinitely — including the env read itself,
 * which is wrapped the same as the DB/manifest checks so a misconfigured
 * server env can never propagate an uncaught exception (and whatever
 * generic body Next.js's own error handling would produce) past this
 * file's own four-field contract.
 *
 * `checkDatabase` scopes a `SET LOCAL statement_timeout` inside its own
 * transaction, shorter than the app-level `CHECK_TIMEOUT_MS` race: without
 * it, an abandoned query (the app gave up waiting, but the query itself
 * keeps running against Postgres) would hold its pool connection for up
 * to db/client.ts's full 10s driver-level statement_timeout — with only
 * MAX_POOL_CONNECTIONS=5 shared with real application traffic, repeated
 * health-check polling during a DB slowdown could exhaust the pool and
 * turn a partial outage into a total one. Cancelling server-side well
 * before the app-level timeout fires releases the connection promptly
 * instead.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getActiveRelease } from "@/modules/content/server-release-registry";
import { getServerEnv } from "@/modules/env/server";

export const runtime = "nodejs";

const CHECK_TIMEOUT_MS = 5_000;
// Below CHECK_TIMEOUT_MS so Postgres cancels and releases the connection
// before the app-level race gives up on it.
const DB_STATEMENT_TIMEOUT_MS = 4_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function checkDatabase(): Promise<boolean> {
  try {
    await withTimeout(
      getDb().transaction(async (tx) => {
        await tx.execute(
          sql.raw(`set local statement_timeout = ${DB_STATEMENT_TIMEOUT_MS}`),
        );
        await tx.execute(sql`select 1`);
      }),
      CHECK_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

async function checkActiveReleaseId(): Promise<string | null> {
  try {
    const release = await withTimeout(getActiveRelease(), CHECK_TIMEOUT_MS);
    return release.releaseId;
  } catch {
    return null;
  }
}

function checkAuthEnabled(): boolean | null {
  try {
    return getServerEnv().authEnabled;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  const [databaseOk, activeReleaseId] = await Promise.all([
    checkDatabase(),
    checkActiveReleaseId(),
  ]);
  const authEnabled = checkAuthEnabled();
  const healthy =
    databaseOk && activeReleaseId !== null && authEnabled !== null;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "unhealthy",
      database: databaseOk ? "ok" : "unreachable",
      activeReleaseId,
      authEnabled,
    },
    { status: healthy ? 200 : 503 },
  );
}
