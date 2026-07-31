import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every migration has a rollback, checked rather than remembered (Phase 18.1).
 *
 * CLAUDE.md states the convention and then says the quiet part: "nothing
 * checks this". This file is that check.
 *
 * The obvious version of it — count the files in each directory and compare —
 * would be WRONG here, and reporting that as a defect is exactly the mistake
 * this comment exists to stop the next reader making. The two directories are
 * numbered on different schemes. `db/migrations/` is numbered by Drizzle's own
 * journal; `db/rollback/` is numbered by Safwa's LOGICAL migrations. They are
 * offset by one, because `0001_server_foundation_down.sql` reverses both
 * `0000_cheerful_yellow_claw.sql` and `0001_zippy_zarek.sql` — the second was
 * a pre-merge correction that only added columns to tables the first created,
 * so one set of DROPs undoes both. A 1:1 count check would fail on a correct
 * repository, and the natural way to "fix" it would be to write a redundant
 * 0000 rollback that drops tables another file already drops.
 *
 * So coverage is asserted the way the rollback files themselves already
 * express it: each one names, in its header, the migration file(s) it
 * reverses. That declaration is load-bearing prose, and this turns it into
 * something that fails a test when it stops being true.
 *
 * What this does NOT check: that a rollback is CORRECT — that its DROPs and
 * ALTERs actually reverse the migration's delta. Nothing automated can, short
 * of applying both against a live database and diffing the schema.
 * `tests/integration/migration-atomicity.test.ts` covers the forward path;
 * the reverse remains a reviewed, manually-run procedure, as every rollback
 * file's own header says.
 */
const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");
const ROLLBACK_DIR = join(process.cwd(), "db", "rollback");

function sqlFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** Every migration file, by basename. `meta/` is Drizzle bookkeeping, not a migration. */
const migrations = sqlFilesIn(MIGRATIONS_DIR);

/** Each rollback file paired with its full text, so a claim can be located. */
const rollbacks = sqlFilesIn(ROLLBACK_DIR).map((name) => ({
  name,
  text: readFileSync(join(ROLLBACK_DIR, name), "utf8"),
}));

/**
 * The rollback files that name a given migration. The reference is matched as
 * `db/migrations/<basename>`, which is how every existing header spells it —
 * a bare `0003` would also match a version number or a line of SQL.
 */
function rollbacksClaiming(migration: string): string[] {
  return rollbacks
    .filter(({ text }) => text.includes(`db/migrations/${migration}`))
    .map(({ name }) => name);
}

describe("migration rollback coverage", () => {
  it("finds both directories populated, so a typo cannot vacuously pass", () => {
    // Without this, an empty or renamed directory would make every
    // it.each below iterate zero times and the suite would report success.
    expect(migrations.length).toBeGreaterThan(0);
    expect(rollbacks.length).toBeGreaterThan(0);
  });

  it.each(migrations)("%s is claimed by exactly one rollback", (migration) => {
    const claimants = rollbacksClaiming(migration);
    expect(
      claimants,
      claimants.length === 0
        ? `No file in db/rollback/ names db/migrations/${migration}. Every migration ships a matching hand-written rollback (CLAUDE.md). Write one, or — if an existing rollback already reverses this migration's delta, as 0001 does for 0000 — say so in that file's header using the exact path "db/migrations/${migration}".`
        : `db/migrations/${migration} is claimed by more than one rollback (${claimants.join(", ")}). Two files each believing they own the reverse of one migration is how a rollback gets run twice or not at all.`,
    ).toHaveLength(1);
  });

  it.each(rollbacks.map((r) => r.name))("%s names what it reverses", (name) => {
    const claimed = migrations.filter((migration) =>
      rollbacksClaiming(migration).includes(name),
    );
    expect(
      claimed,
      `db/rollback/${name} does not name any file in db/migrations/. Its header must reference the migration(s) it reverses by path, both so a reader knows what running it undoes and so this test can see the coverage.`,
    ).not.toHaveLength(0);
  });
});
