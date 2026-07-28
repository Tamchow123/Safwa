-- Rollback for Safwa's migration 0004 (guest-merge markers, Phase 17),
-- committed as db/migrations/0004_volatile_lord_hawal.sql. It reverses ONLY the
-- 0004 delta: two `study_components` columns, one `review_events` column, and
-- the one check constraint that migration added. It touches no other table and
-- deletes no learner data.
--
-- WHAT 0004 ADDED, AND WHY REMOVING IT MATTERS MORE THAN IT LOOKS:
-- `merged_at` is not decoration. The server refuses to replay a component whose
-- accepted events form more than one chain UNLESS that component carries this
-- stamp — the stamp is what separates an authorised guest→account merge from
-- corruption (a bad migration, a manual repair, a restore interleaving two
-- histories). Dropping the column therefore does NOT return a merged component
-- to a working state: it returns it to the state the server treats as corrupt,
-- and every read path over it — push ingestion, ordinary pull, undo/revoke —
-- will abort with a ChainError instead of serving a card.
--
-- DATA LOSS, STATED PLAINLY: no review event, attempt, bookmark, list or
-- setting is deleted by this script, and no merged history is unmerged. What is
-- lost is the SERVER'S PERMISSION to read the merged components back. Any
-- account that completed a guest merge while 0004 was applied will find those
-- components unreadable until 0004 is re-applied. There is no way to recompute
-- the stamp afterwards from the event log alone: a multi-rooted component looks
-- identical whether its union was authorised or accidental, which is the entire
-- reason the stamp exists rather than being inferred.
--
-- So: prefer disabling the feature flag (SYNC_ENABLED / the merge entry point)
-- over running this, exactly as Phase 16 established. Run this only when the
-- schema objects themselves must go, and expect to re-apply 0004 before any
-- account that has merged can sync again.
--
-- The count of affected components is reported before the columns are dropped,
-- so the operator sees the blast radius rather than discovering it from support
-- tickets.
--
-- SAFETY GUARD: this script is correct ONLY when 0004 is the most recently
-- applied migration. The guard below aborts loudly if a later migration (0005+)
-- has since been applied, so running the wrong rollback file against a
-- further-progressed database can never silently corrupt Drizzle's
-- migration-tracking history (it would otherwise delete the newest tracking
-- row, not 0004's). Requires a fresh backup confirmation. Manual only — never
-- applied automatically by any script.
--
-- Usage (manual, after taking a backup):
--   psql "$DATABASE_URL" -f db/rollback/0004_merge_marker_down.sql

BEGIN;

-- Abort unless exactly the 0000 + 0001 + 0002 + 0003 + 0004 migrations are
-- applied (i.e. 0004 is the newest). Drizzle tracks applied migrations in
-- drizzle.__drizzle_migrations.
DO $$
DECLARE
  applied integer;
BEGIN
  SELECT count(*) INTO applied FROM drizzle.__drizzle_migrations;
  IF applied <> 5 THEN
    RAISE EXCEPTION
      'refusing to roll back 0004: expected exactly 5 applied migrations (0000-0004), found %. Use the rollback script matching the newest applied migration.',
      applied;
  END IF;
END $$;

-- Report the blast radius before destroying the evidence of it.
DO $$
DECLARE
  merged integer;
BEGIN
  SELECT count(*) INTO merged FROM "study_components" WHERE "merged_at" IS NOT NULL;
  IF merged > 0 THEN
    RAISE WARNING
      'dropping the merge marker from % component(s) that were legitimately merged; those components will be treated as corrupt (ChainError on ingest, pull and revoke) until migration 0004 is re-applied',
      merged;
  END IF;
END $$;

-- The constraint 0004 added.
ALTER TABLE "study_components" DROP CONSTRAINT IF EXISTS "study_components_merge_provenance_check";

-- The columns 0004 added. Dropping `imported_from_guest_import_id` erases WHICH
-- events an import wrote; the events themselves stay, and their lineage stays
-- intact, but after this they are indistinguishable from ordinary history.
ALTER TABLE "review_events" DROP COLUMN IF EXISTS "imported_from_guest_import_id";
ALTER TABLE "study_components" DROP COLUMN IF EXISTS "merged_from_guest_import_id";
ALTER TABLE "study_components" DROP COLUMN IF EXISTS "merged_at";

-- Remove 0004's migration-tracking row so Drizzle re-applies it cleanly.
DELETE FROM drizzle.__drizzle_migrations
WHERE id = (SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1);

COMMIT;
