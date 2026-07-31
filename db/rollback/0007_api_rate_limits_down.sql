-- Rollback for Safwa's migration 0007 (API rate-limit counters, Phase 18.1),
-- committed as db/migrations/0007_true_orphan.sql. It reverses ONLY the 0007
-- delta: one new table and its one index. It touches no other table and
-- deletes no learner data.
--
-- WHAT 0007 ADDED:
-- `api_rate_limits` — fixed-window request counters for the four API routes
-- Better Auth's own rate limiter does not cover (/api/sync/push, /api/sync/pull,
-- /api/sync/guest-merge, /api/account/settings). One row per
-- `<bucket>:<account-id>` key, holding a count and the instant its window
-- opened. Deliberately NOT Better Auth's `rate_limits` table, which Better Auth
-- prunes on its own schedule with no key filter — see db/schema/rate-limit.ts.
--
-- DATA LOSS, STATED PLAINLY: none that matters. Every row is an ephemeral
-- counter whose whole lifetime is one window (at most a few minutes), and the
-- table is pruned opportunistically anyway. No review event, attempt, bookmark,
-- list, setting or account record is touched. Nothing here is recoverable
-- because nothing here is worth recovering.
--
-- WHAT DROPPING THIS DOES TO THE RUNNING APP, WHICH IS THE PART TO THINK ABOUT:
-- `consumeRateLimit` FAILS OPEN by design — if its statement throws, the
-- request is allowed and the failure is logged. So running this against a
-- database whose application code still calls the limiter does not break sync;
-- it silently removes the ceiling and writes an error line per limited request.
-- That is survivable but it is not a state to sit in. Roll the APPLICATION back
-- first and the schema second, which is the ordering docs/DEPLOYMENT.md already
-- prescribes for every migration in this repository.
--
-- The index is dropped explicitly before the table. Postgres would remove it
-- with the table anyway; naming it here keeps this file a complete inventory of
-- what 0007 created, so a reader can check the reverse against the forward
-- without opening the migration.
--
-- Usage (manual, after taking a backup):
--   psql "$DATABASE_URL" -f db/rollback/0007_api_rate_limits_down.sql

BEGIN;

DROP INDEX IF EXISTS "api_rate_limits_window_started_idx";
DROP TABLE IF EXISTS "api_rate_limits";

COMMIT;
