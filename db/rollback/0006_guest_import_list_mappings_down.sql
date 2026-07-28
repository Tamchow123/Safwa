-- Rollback for Safwa's migration 0006 (guest-import list-id mappings, Phase 17),
-- committed as db/migrations/0006_simple_inhumans.sql. It reverses ONLY the 0006
-- delta: one new table. It touches no other table and deletes no learner data.
--
-- WHAT 0006 ADDED:
-- `guest_import_list_mappings` — the guest-list-id → account-list-id pairs one
-- import produced (§17), keyed by (import_id, guest_list_id) so recording them
-- is idempotent across a re-sent chunk.
--
-- WHY IT EXISTS, WHICH IS ALSO WHY DROPPING IT MATTERS:
-- The mappings are produced by `chunk` requests and consumed by the `finalize`
-- request. Those are separate HTTP requests, and on this deployment (Vercel
-- serverless) they are routinely served by different instances, so the mapping
-- cannot live in process memory. Nor can it be recomputed later: once an import
-- is `completed` the coordinator refuses to re-apply its chunks, which is
-- precisely what idempotency requires of it. This table is the only place the
-- pairing exists.
--
-- DATA LOSS, STATED PLAINLY: no review event, attempt, bookmark, list, setting
-- or import record is deleted by this script. No merge is unmerged; every list
-- the merge created or folded stays exactly as it is, with its membership. What
-- is lost is the client's ability to RE-KEY its local guest list ids for any
-- import that has not yet finalised — those clients still hold guest ids that
-- now name nothing on the account, and on their next sync will either duplicate
-- the list or lose the membership just merged.
--
-- So: prefer disabling the merge entry point over running this, and expect to
-- re-apply 0006 before any in-flight merge finalises. Imports already finalised
-- are unaffected — their clients have long since re-keyed.
--
-- The count of affected in-flight imports is reported before the table is
-- dropped, so the operator sees the blast radius rather than discovering it
-- from support tickets.
--
-- SAFETY GUARD: this script is correct ONLY when 0006 is the most recently
-- applied migration. The guard below aborts loudly if a later migration (0007+)
-- has since been applied, so running the wrong rollback file against a
-- further-progressed database can never silently corrupt Drizzle's
-- migration-tracking history (it would otherwise delete the newest tracking
-- row, not 0006's). Requires a fresh backup confirmation. Manual only — never
-- applied automatically by any script.
--
-- Usage (manual, after taking a backup):
--   psql "$DATABASE_URL" -f db/rollback/0006_guest_import_list_mappings_down.sql

BEGIN;

-- Abort unless exactly the 0000 + 0001 + 0002 + 0003 + 0004 + 0005 + 0006
-- migrations are applied (i.e. 0006 is the newest). Drizzle tracks applied
-- migrations in drizzle.__drizzle_migrations.
DO $$
DECLARE
  applied integer;
BEGIN
  SELECT count(*) INTO applied FROM drizzle.__drizzle_migrations;
  IF applied <> 7 THEN
    RAISE EXCEPTION
      'refusing to roll back 0006: expected exactly 7 applied migrations (0000-0006), found %. Use the rollback script matching the newest applied migration.',
      applied;
  END IF;
END $$;

-- Report the blast radius before destroying the evidence of it.
DO $$
DECLARE
  in_flight integer;
BEGIN
  SELECT count(DISTINCT m."import_id") INTO in_flight
    FROM "guest_import_list_mappings" m
    JOIN "guest_imports" i ON i."id" = m."import_id"
   WHERE i."status" = 'open';
  IF in_flight > 0 THEN
    RAISE WARNING
      'dropping list-id mappings for % import(s) still in flight; those clients cannot re-key their local guest list ids and will duplicate or orphan those lists on the next sync unless 0006 is re-applied before they finalise',
      in_flight;
  END IF;
END $$;

-- The table 0006 added. Its only foreign key is its own, so dropping the table
-- drops it; nothing else references this table.
DROP TABLE IF EXISTS "guest_import_list_mappings";

-- Remove 0006's migration-tracking row so Drizzle re-applies it cleanly.
DELETE FROM drizzle.__drizzle_migrations
WHERE id = (SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1);

COMMIT;
