# ADR-008: `drizzle-orm/node-postgres` + `pg` as the Postgres driver

- Status: Accepted
- Date: 2026-07-21

## Context

Drizzle ORM supports several Postgres driver adapters
(`drizzle-orm/node-postgres` over `pg`, `drizzle-orm/neon-serverless` over
`@neondatabase/serverless`, `drizzle-orm/postgres-js`, …). Phase 15 needed to
pick one for `db/client.ts`, the migration/reset/register-content CLI
scripts, and the disposable-Postgres integration/E2E test harnesses.

## Decision

`drizzle-orm/node-postgres` over the standard `pg` package, with one lazily-
initialised `Pool`/`Database` singleton per process (`db/client.ts`, stashed
on `globalThis` to survive Next.js dev-mode hot reloads). TLS is required for
production, for any explicit `sslmode=require|verify-full|verify-ca`
connection string, and — the fail-safe default — for any host that isn't
loopback (`localhost`/`127.0.0.1`/`::1`), so a bare connection string pointed
at a real remote Postgres never silently negotiates plaintext. The pool caps
at 5 connections per instance (`MAX_POOL_CONNECTIONS`), deliberately
conservative for a serverless deployment target where each concurrently-warm
function instance holds its own pool. Query/statement timeouts default to
10s.

Neon's standard **pooled** connection string (PgBouncer-fronted, plain
Postgres wire protocol) works unmodified against this driver — no
Neon-specific serverless/edge driver is required, because the app targets
Node.js runtime API routes and standalone CLI scripts, never the Edge
runtime.

## Consequences

- Standard Postgres driver behaviour (no HTTP-fetch-based query protocol, no
  Edge-runtime constraint) — every DB-touching module (`db/client.ts`,
  `db/migrate.ts`, `db/reset-test-database.ts`, `db/register-content.ts`,
  `e2e/helpers/db-probe.ts`) can construct its own `Pool`/`drizzle()` instance
  identically, whether server-only (Next.js) or a plain Node/tsx script.
- `db/client.ts` (the shared pooled instance) and the standalone CLI scripts
  that transitively import it are `server-only`-tagged and must run under
  `tsx --conditions=react-server` (see `ARCHITECTURE.md` §"Standalone CLI
  scripts and `server-only`"); `db/schema.ts` (the bare table definitions)
  carries no such marker and is safely importable from any Node process,
  including Playwright's E2E test runner (`e2e/helpers/db-probe.ts` builds
  its own throwaway `Pool` + `drizzle(pool, { schema })` instead of importing
  `db/client.ts`, for exactly this reason).
- If a future deployment target requires the Edge runtime for a DB-touching
  route, this decision would need revisiting (a serverless/HTTP driver
  adapter, or keeping that route on the Node runtime explicitly).
