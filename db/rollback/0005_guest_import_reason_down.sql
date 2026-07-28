-- Rollback for Safwa's migration 0005 (guest-import reason code, Phase 17),
-- committed as db/migrations/0005_brown_wild_child.sql. It reverses ONLY the
-- 0005 delta: one `guest_imports` column and the two check constraints that
-- migration added. It touches no other table and deletes no learner data.
--
-- WHAT 0005 ADDED:
-- `guest_imports.reason_code` — the protocol's own import-level reason code
-- (`GUEST_MERGE_REASON_CODES`) recorded against the import it explains, plus
-- two constraints: one bounding the column to that vocabulary, and one
-- requiring any CONCLUDED import (status <> 'open') to carry a reason at all.
--
-- DATA LOSS, STATED PLAINLY: no review event, attempt, bookmark, list, setting
-- or import record is deleted by this script. No merge is unmerged and no
-- import changes status. What is lost is the stored EXPLANATION for every
-- import that was refused or completed — the answer to "why was this history
-- not taken?" for each affected learner. That answer cannot be recomputed
-- afterwards: it was a decision made against a payload the server deliberately
-- does not retain (§30 keeps raw payloads out of durable storage), so the same
-- import key re-presented later can no longer be told anything more specific
-- than its status.
--
-- Unlike 0004, this rollback leaves the system fully FUNCTIONAL. The reason
-- code is reporting, not a gate: nothing reads it to decide whether an import
-- may proceed, so dropping it degrades what the client and an operator can be
-- told without making any record unreadable. That is why this script does not
-- carry 0004's "prefer the feature flag" warning — the blast radius here is
-- explanations, not availability.
--
-- The count of imports about to lose their explanation is reported before the
-- column is dropped, so the operator sees the blast radius rather than
-- discovering it from support tickets.
--
-- SAFETY GUARD: this script is correct ONLY when 0005 is the most recently
-- applied migration. The guard below aborts loudly if a later migration (0006+)
-- has since been applied, so running the wrong rollback file against a
-- further-progressed database can never silently corrupt Drizzle's
-- migration-tracking history (it would otherwise delete the newest tracking
-- row, not 0005's). Requires a fresh backup confirmation. Manual only — never
-- applied automatically by any script.
--
-- RE-APPLYING 0005 AFTERWARDS: this script removes 0005's migration-tracking
-- row, so the ordinary migration path re-applies it. One caveat. The column
-- comes back NULL for every existing row, which the vocabulary constraint
-- accepts — but the terminal-reason constraint requires every non-`open` import
-- to carry a reason, and rows that concluded while 0005 was rolled back would
-- have none. Re-applying against such a database therefore FAILS at the
-- constraint rather than silently admitting mute terminal rows. That failure is
-- the correct outcome: it is visible, and it names exactly the rows needing a
-- decision. Backfill them first, choosing per status:
--
--   UPDATE guest_imports SET reason_code = 'already_completed'
--    WHERE status = 'completed' AND reason_code IS NULL;
--   UPDATE guest_imports SET reason_code = 'internal_error'
--    WHERE status = 'rejected' AND reason_code IS NULL;
--
-- ('internal_error' is the honest choice for a rejection whose real reason was
-- destroyed by the rollback — it says "the server refused and can no longer say
-- why", which is true, rather than inventing a specific cause.)
--
-- Usage (manual, after taking a backup):
--   psql "$DATABASE_URL" -f db/rollback/0005_guest_import_reason_down.sql

BEGIN;

-- Abort unless exactly the 0000 + 0001 + 0002 + 0003 + 0004 + 0005 migrations
-- are applied (i.e. 0005 is the newest). Drizzle tracks applied migrations in
-- drizzle.__drizzle_migrations.
DO $$
DECLARE
  applied integer;
BEGIN
  SELECT count(*) INTO applied FROM drizzle.__drizzle_migrations;
  IF applied <> 6 THEN
    RAISE EXCEPTION
      'refusing to roll back 0005: expected exactly 6 applied migrations (0000-0005), found %. Use the rollback script matching the newest applied migration.',
      applied;
  END IF;
END $$;

-- Report the blast radius before destroying the evidence of it.
DO $$
DECLARE
  explained integer;
BEGIN
  SELECT count(*) INTO explained FROM "guest_imports" WHERE "reason_code" IS NOT NULL;
  IF explained > 0 THEN
    RAISE WARNING
      'dropping the stored reason from % guest import(s); those imports keep their status but can no longer say why they ended that way, and the reason cannot be recomputed. Re-applying 0005 requires backfilling every non-open row first (see this file''s header)',
      explained;
  END IF;
END $$;

-- The constraints 0005 added. Dropped before the column they reference.
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_terminal_reason_check";
ALTER TABLE "guest_imports" DROP CONSTRAINT IF EXISTS "guest_imports_reason_code_check";

-- The column 0005 added.
ALTER TABLE "guest_imports" DROP COLUMN IF EXISTS "reason_code";

-- Remove 0005's migration-tracking row so Drizzle re-applies it cleanly.
DELETE FROM drizzle.__drizzle_migrations
WHERE id = (SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1);

COMMIT;
