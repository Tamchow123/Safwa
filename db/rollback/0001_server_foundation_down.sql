-- Rollback for Safwa's logical migration 0001 (server foundation), which
-- Drizzle generated and committed as db/migrations/0000_*.sql — the
-- 0000-vs-0001 naming mismatch is Drizzle's own journal numbering; see
-- docs/ARCHITECTURE.md for the mapping. This DROPS every table this
-- migration introduced and DESTROYS all account/server data. It is a
-- reviewed, manually-run rollback path — never applied automatically by
-- any script in this repository. Requires a fresh backup confirmation
-- before running against any database containing real users
-- (docs/phases/phases-15.md §64). Disabling AUTH_ENABLED is the preferred
-- immediate application-level rollback; only run this SQL if the tables
-- themselves must be removed.
--
-- Deliberately NO CASCADE on any table drop below: the order is already
-- dependency-safe (every table is dropped only after everything that
-- references it), so a plain DROP fails loudly if a later phase added an
-- unforeseen FK onto one of these tables, instead of silently widening the
-- blast radius to whatever CASCADE happens to pull in.
--
-- Usage (manual, after taking a backup):
--   psql "$DATABASE_URL" -f db/rollback/0001_server_foundation_down.sql

BEGIN;

DROP TABLE IF EXISTS "review_events";
DROP TABLE IF EXISTS "study_attempts";
DROP TABLE IF EXISTS "study_components";
DROP TABLE IF EXISTS "study_sessions";
DROP TABLE IF EXISTS "daily_activity";
DROP TABLE IF EXISTS "custom_list_entries";
DROP TABLE IF EXISTS "custom_lists";
DROP TABLE IF EXISTS "bookmarks";
DROP TABLE IF EXISTS "guest_imports";
DROP TABLE IF EXISTS "user_settings";
DROP TABLE IF EXISTS "skill_types";
DROP TABLE IF EXISTS "content_versions";
DROP TABLE IF EXISTS "accounts";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "verifications";
DROP TABLE IF EXISTS "rate_limits";
DROP TABLE IF EXISTS "users";

-- Drizzle's own migration-tracking schema (not application data) — CASCADE
-- here only ever affects Drizzle's internal bookkeeping table, so a future
-- `pnpm db:migrate` starts clean rather than believing 0001 is applied.
DROP SCHEMA IF EXISTS "drizzle" CASCADE;

COMMIT;
