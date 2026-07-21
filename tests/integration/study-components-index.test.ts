import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { studyComponents } from "@/db/schema";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Planner/index-usability check for `study_components_due_idx`
 * (phases-15.md §53), kept separate from study-components.test.ts's fast,
 * single-row constraint-rejection suite: this file seeds real volume
 * (600 rows) so the cost-based planner has a genuine reason to prefer the
 * index over a sequential scan, which a handful of rows never would.
 */
const ENTRY_SKILL = "bab_identification"; // entry_level

describe("study_components due-lookup index", () => {
  it("the (user_id, due_at) index exists", async () => {
    const db = getDb();
    const indexes = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'study_components' AND indexname = 'study_components_due_idx'`,
    );
    expect(indexes.rows).toHaveLength(1);
  });

  it("the planner actually chooses the index for a realistic due-lookup query", async () => {
    const db = getDb();
    // A near-empty table's cost-based planner always prefers a seq scan
    // regardless of the index's existence — seed enough rows across enough
    // distinct users that filtering to ONE user_id is genuinely selective,
    // so this is a real proof of usability, not just of existence. One
    // flattened insert (not one round trip per user) keeps this cheap.
    const userIds = await Promise.all(
      Array.from({ length: 30 }, () => createTestUser("due-index-fixture")),
    );
    const rows = userIds.flatMap((userId) =>
      Array.from({ length: 20 }, (_, i) => ({
        userId,
        entryId: i + 1,
        skillTypeId: ENTRY_SKILL,
        componentShape: "entry_level" as const,
        dueAt: new Date(Date.now() + i * 60_000),
      })),
    );
    await db.insert(studyComponents).values(rows);
    await db.execute(sql`ANALYZE study_components`);

    const [target] = userIds;
    const plan = await db.execute(
      sql`EXPLAIN SELECT id FROM study_components WHERE user_id = ${target} AND due_at < now() + interval '1 hour'`,
    );
    const planText = plan.rows.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("study_components_due_idx");
  });
});
