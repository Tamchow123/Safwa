/**
 * Explicit migration runner (Phase 15) — `pnpm db:migrate`. Never invoked
 * automatically at application startup/build; production applies this as
 * its own deploy step before promoting a build (DEPLOYMENT.md §5).
 *
 * Also idempotently seeds the 5 current `skill_types` rows (phases-15.md
 * §17): safe to re-run and self-heals a `display_name`/`is_active` edit
 * without a new migration.
 *
 * Run via `tsx --conditions=react-server` (baked into the `db:migrate`
 * script), not plain `tsx`: this file transitively imports db/client.ts,
 * which is marked `server-only`. Next.js's webpack build resolves that
 * package's `react-server` export condition to an empty module; a bare
 * Node/tsx process resolves its `default` condition instead, which throws
 * by design. Passing `--conditions=react-server` makes a standalone script
 * resolve the same (correct, non-throwing) branch Next.js does — this is
 * not weakening the guard, since a CLI script was never a client bundle in
 * the first place.
 */
import { pathToFileURL } from "node:url";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "@/db/client";
import { skillTypes } from "@/db/schema";
import { SKILL_TYPE_SEED, seedSkillTypes } from "@/db/seed";

async function main(): Promise<void> {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./db/migrations" });
  await seedSkillTypes(db);
  // Verify every EXPECTED id is present (not just a row count, which could
  // pass even with a stale/renamed id silently missing alongside an
  // unrelated extra row — fail loudly, not silently).
  const expectedIds = SKILL_TYPE_SEED.map((row) => row.id);
  const present = await db
    .select({ id: skillTypes.id })
    .from(skillTypes)
    .where(inArray(skillTypes.id, expectedIds));
  const missing = expectedIds.filter(
    (id) => !present.some((row) => row.id === id),
  );
  if (missing.length > 0) {
    throw new Error(
      `skill_types seed incomplete: missing ${missing.join(", ")}`,
    );
  }
}

// Only run when executed directly (`tsx db/migrate.ts`), never merely by
// being imported. Compared via pathToFileURL (not a plain template-string
// "file://" prefix) because process.argv[1] is a native OS path — on
// Windows that's backslash-separated and would never string-equal
// import.meta.url's forward-slash file:// form.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  // Dynamic, not a static top-level import: loading .env.local must only
  // ever happen for a real CLI run, never as a side effect of a test file
  // importing this module's exports.
  import("@/db/load-env")
    .then(main)
    .then(async () => {
      console.log("Migrations applied and skill_types seeded.");
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error("Migration failed:", error);
      await closeDb();
      process.exit(1);
    });
}
