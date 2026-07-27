-- Rollback for Safwa's migration 0003 (guest→account merge, Phase 17),
-- committed as db/migrations/0003_married_cerise.sql. It reverses ONLY the
-- 0003 delta: the columns, constraints and indexes 0003 added to
-- `guest_imports`, restoring that table to exactly its Phase-15 shape.
--
-- It does NOT drop `guest_imports` itself — Phase 15 created it, so dropping it
-- here would reverse a migration this file is not responsible for — and it
-- touches no other table. No account learning state, collection or setting is
-- affected, consistent with the operational rollback posture Phase 16
-- established: disabling the feature flag is the preferred immediate,
-- non-destructive rollback, and this SQL is only for when the schema objects
-- themselves must go.
--
-- DATA LOSS, STATED PLAINLY: dropping `snapshot_hash`, `status`, `result`'s
-- widened vocabulary and the counters discards the audit trail of every merge
-- already performed. The merged learner data itself survives — it lives in
-- review_events / study_attempts / bookmarks / custom_lists, which this script
-- does not touch — but the record of WHICH import produced it does not. After
-- this runs, a client resubmitting an import key the server has forgotten would
-- be treated as a fresh import; the underlying attempt/event idempotency still
-- prevents duplicate history, but the import-level no-op guarantee is gone
-- until 0003 is re-applied.
--
-- Restoring `result` to NOT NULL would fail on any row 0003 left with a NULL
-- result (an import that was still open). Those rows are deleted first, which
-- is correct: an open import has no terminal outcome to preserve and its client
-- can simply start again. A COMPLETED import's row is kept, with its result
-- narrowed back to the Phase-15 vocabulary — and an `incomplete` result has no
-- Phase-15 equivalent, so those rows are deleted too rather than being
-- misrecorded as `rejected`, which would claim a terminal failure that never
-- happened.
--
-- SAFETY GUARD: this script is correct ONLY when 0003 is the most recently
-- applied migration. The guard below aborts loudly if a later migration (0004+)
-- has since been applied, so running the wrong rollback file against a
-- further-progressed database can never silently corrupt Drizzle's
-- migration-tracking history (it would otherwise delete the newest tracking
-- row, not 0003's). Requires a fresh backup confirmation. Manual only — never
-- applied automatically by any script.
--
-- Usage (manual, after taking a backup):
--   psql "$DATABASE_URL" -f db/rollback/0003_guest_merge_down.sql

BEGIN;

-- Abort unless exactly the 0000 + 0001 + 0002 + 0003 migrations are applied
-- (i.e. 0003 is the newest). Drizzle tracks applied migrations in
-- drizzle.__drizzle_migrations.
DO $$
DECLARE
  applied integer;
BEGIN
  SELECT count(*) INTO applied FROM drizzle.__drizzle_migrations;
  IF applied <> 4 THEN
    RAISE EXCEPTION
      'refusing to roll back 0003: expected exactly 4 applied migrations (0000-0003), found %. Use the rollback script matching the newest applied migration.',
      applied;
  END IF;
END $$;

-- Rows 0003 made representable that Phase 15's shape cannot hold: an open
-- import (NULL result) and an incomplete one (no Phase-15 equivalent).
DELETE FROM "guest_imports"
WHERE "result" IS NULL OR "result" = 'incomplete';

-- Constraints and indexes 0003 added.
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_result_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_status_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_completion_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_declared_items_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_accepted_items_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_next_chunk_index_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_accepted_lists_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_final_server_cursor_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_snapshot_hash_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_summary_numeric_check";
DROP INDEX IF EXISTS "guest_imports_user_snapshot_completed_idx";
DROP INDEX IF EXISTS "guest_imports_key_idx";

-- Columns 0003 added.
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "completed_at";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "summary";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "final_server_cursor";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "accepted_lists";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "next_chunk_index";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "accepted_items";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "declared_items";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "status";
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "snapshot_hash";

-- Restore the Phase-15 shape of `result`: NOT NULL, three-value vocabulary.
ALTER TABLE "guest_imports" ALTER COLUMN "result" SET NOT NULL;
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_result_check"
  CHECK ("result" IN ('applied', 'no_op', 'rejected'));

-- Remove 0003's migration-tracking row so Drizzle re-applies it cleanly.
DELETE FROM drizzle.__drizzle_migrations
WHERE id = (SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1);

COMMIT;
