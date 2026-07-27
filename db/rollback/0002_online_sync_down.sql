-- Rollback for Safwa's migration 0002 (online sync, Phase 16), committed as
-- db/migrations/0002_thick_mentallo.sql. It reverses ONLY the 0002 delta:
-- drops the three new sync tables (user_sync_state, sync_tombstones,
-- sync_audit_log) and removes the columns / constraints / indexes 0002 added
-- to the Phase 15 tables. It does NOT touch any Phase 15 table's own data
-- beyond the added columns, so the account learning state, collections and
-- settings survive intact — consistent with the operational rollback in
-- phases-16.md §24 ("Preserve all server data. Continue local-only study.
-- Re-enable without requiring destructive migration"). Disabling SYNC_ENABLED
-- is the preferred immediate, non-destructive rollback; only run this SQL if
-- the schema objects themselves must be removed.
--
-- Deliberately NO CASCADE on the table drops: nothing references these three
-- tables, so a plain DROP fails loudly if a later phase adds an unforeseen FK
-- onto one of them instead of silently widening the blast radius.
--
-- SAFETY GUARD: this script is correct ONLY when 0002 is the most recently
-- applied migration. The guard below aborts loudly if a later migration
-- (0003+) has since been applied, so running the wrong rollback file against a
-- further-progressed database can never silently corrupt Drizzle's
-- migration-tracking history (it would otherwise delete the newest tracking
-- row, not 0002's). Requires a fresh backup confirmation. Manual only — never
-- applied automatically by any script.
--
-- Usage (manual, after taking a backup):
--   psql "$DATABASE_URL" -f db/rollback/0002_online_sync_down.sql

BEGIN;

-- Abort unless exactly the 0000 + 0001 + 0002 migrations are applied (i.e. 0002
-- is the tip). If 0003+ exist, refuse rather than delete the wrong tip row.
DO $$
DECLARE
  applied_count integer;
BEGIN
  SELECT count(*) INTO applied_count FROM "drizzle"."__drizzle_migrations";
  IF applied_count <> 3 THEN
    RAISE EXCEPTION
      'Refusing to run the 0002 rollback: expected exactly 3 applied migrations (0002 as the tip) but found %. A later migration has been applied; do not use this rollback file.',
      applied_count;
  END IF;
END $$;

-- New sync tables (no inbound FKs).
DROP TABLE IF EXISTS "sync_audit_log";
DROP TABLE IF EXISTS "sync_tombstones";
DROP TABLE IF EXISTS "user_sync_state";

-- Indexes added to Phase 15 tables (dropped explicitly before their columns).
DROP INDEX IF EXISTS "review_events_sync_idx";
DROP INDEX IF EXISTS "study_components_sync_idx";
DROP INDEX IF EXISTS "bookmarks_user_seq_idx";
DROP INDEX IF EXISTS "custom_lists_sync_idx";

-- Columns added to Phase 15 tables (dropping a column also drops its own
-- CHECK constraints).
ALTER TABLE "study_components" DROP COLUMN IF EXISTS "last_sync_seq";
ALTER TABLE "bookmarks" DROP COLUMN IF EXISTS "last_sync_seq";
ALTER TABLE "custom_lists" DROP COLUMN IF EXISTS "last_sync_seq";
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "last_sync_seq";

ALTER TABLE "review_events" DROP COLUMN IF EXISTS "clock_suspect";
ALTER TABLE "review_events" DROP COLUMN IF EXISTS "idempotency_payload_hash";
ALTER TABLE "review_events" DROP COLUMN IF EXISTS "revoked_at";
ALTER TABLE "review_events" DROP COLUMN IF EXISTS "pending_expires_at";
ALTER TABLE "review_events" DROP COLUMN IF EXISTS "last_sync_seq";

ALTER TABLE "study_attempts" DROP COLUMN IF EXISTS "idempotency_payload_hash";

-- Remove ONLY 0002's migration-tracking row (guaranteed to be the tip by the
-- guard above) so a subsequent `pnpm db:migrate` re-applies 0002 and nothing
-- earlier.
DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "hash" = (
  SELECT "hash" FROM "drizzle"."__drizzle_migrations"
  ORDER BY "created_at" DESC
  LIMIT 1
);

COMMIT;
