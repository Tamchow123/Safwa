import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import { contentVersions } from "@/db/schema";
import { readRegistry } from "@/modules/content/server-release-registry";

const VALID_HEX64 = "a".repeat(64);

/**
 * Inserts a fixture `content_versions` row and returns its `release_id`.
 * Every study_sessions/study_attempts/review_events row must reference a
 * real release (release_id is NOT NULL + FK), so tests that only care
 * about those tables' own constraints — not content registration itself —
 * use this instead of running the full `db/register-content.ts` flow.
 */
export async function createTestRelease(
  overrides: Partial<typeof contentVersions.$inferInsert> = {},
): Promise<string> {
  const db = getDb();
  const releaseId = overrides.releaseId ?? `release-${randomUUID()}`;
  await db.insert(contentVersions).values({
    contentVersion: "1.0.0",
    schemaVersion: "1",
    questionGeneratorVersion: "1",
    entryCount: 1,
    checksumLearner: VALID_HEX64,
    checksumValidation: VALID_HEX64,
    checksumAssessment: VALID_HEX64,
    releaseStatus: "supported",
    minimumSupportedClientVersion: "0.1.0",
    minimumSupportedEventSchema: 1,
    ...overrides,
    releaseId,
  });
  return releaseId;
}

/**
 * Registers every release in the real registry (as `pnpm db:register-content`
 * does) and returns the ACTIVE one's `release_id` — the release a learner
 * studies today. Not the first id registered: once the registry also holds
 * an older `supported` release (from Phase 18.4 on), that is not the active
 * one, and a suite built on it would quietly exercise superseded content.
 */
export async function registerActiveRelease(): Promise<string> {
  const { registered } = await registerContent(getDb());
  const { active_release_id: activeReleaseId } = await readRegistry();
  if (!registered.includes(activeReleaseId)) {
    throw new Error(`active release ${activeReleaseId} was not registered`);
  }
  return activeReleaseId;
}
