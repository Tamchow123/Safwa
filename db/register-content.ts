/**
 * Idempotent content-release registration (Phase 15, phases-15.md §29) —
 * `pnpm db:register-content`. Verifies every release listed in the server
 * release registry (via T7's `loadAndVerifyRelease`/`readRegistry`) and
 * upserts each into `content_versions` inside one transaction.
 *
 * Release id, content/schema/question-generator version, entry count and
 * the three artifact checksums are immutable once a release id is first
 * registered — a later run that verifies different bytes under the same
 * release id fails closed instead of silently overwriting them. Only the
 * registry's mutable fields (status, minimum_supported_client_version,
 * minimum_supported_event_schema) are ever updated on a repeat run. Never
 * creates vocabulary rows — `content_versions` stores release metadata
 * only (db/schema/content.ts).
 *
 * Every release is verified (filesystem reads + Zod parsing) BEFORE the
 * database transaction opens — verification has no transactional meaning
 * and must never hold a row lock (or the whole transaction) open for the
 * duration of file I/O. The transaction then does DB work only.
 *
 * Run via `tsx --conditions=react-server` (baked into the
 * `db:register-content` script) — see db/migrate.ts for why plain `tsx`
 * cannot import this module's `server-only` dependency chain.
 */
import "server-only";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, type Database } from "@/db/client";
import { contentVersions } from "@/db/schema";
import {
  loadAndVerifyRelease,
  type LoadAndVerifyReleaseOptions,
  type VerifiedRelease,
} from "@/modules/content/server-manifests";
import { readRegistry } from "@/modules/content/server-release-registry";

export class ContentRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentRegistrationError";
  }
}

/**
 * `registryDir`/`contentServerDir`/`publicContentDir` are the same
 * test-fixture-injection surface `loadAndVerifyRelease`/`getActiveRelease`
 * accept (modules/content/server-manifests.ts, server-release-registry.ts)
 * — gated to only take effect under `NODE_ENV=test`. Production call sites
 * never pass this.
 */
export type RegisterContentOptions = LoadAndVerifyReleaseOptions & {
  registryDir?: string;
};

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type RegistryEntry = {
  status: "active" | "supported" | "revoked";
  minimum_supported_client_version: string;
  minimum_supported_event_schema: number;
};

async function registerRelease(
  tx: Tx,
  releaseId: string,
  entry: RegistryEntry,
  verified: VerifiedRelease,
): Promise<void> {
  // A row-level `.for("update")` lock only exists once a matching row is
  // present — it cannot by itself stop two concurrent first-time
  // registrations of the same (not-yet-registered) release id from both
  // observing "no row" and racing each other to INSERT. A transaction-
  // scoped advisory lock keyed on the release id provides real mutual
  // exclusion regardless of whether a row exists yet, and is released
  // automatically at commit/rollback (no matching unlock call needed).
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${releaseId}), 0)`,
  );

  const [existing] = await tx
    .select()
    .from(contentVersions)
    .where(eq(contentVersions.releaseId, releaseId))
    .for("update");

  if (existing) {
    if (
      existing.contentVersion !== verified.contentVersion ||
      existing.schemaVersion !== verified.schemaVersion ||
      existing.questionGeneratorVersion !== verified.questionGeneratorVersion ||
      existing.entryCount !== verified.entryCount ||
      existing.checksumLearner !== verified.checksums.learner ||
      existing.checksumValidation !== verified.checksums.validation ||
      existing.checksumAssessment !== verified.checksums.assessment
    ) {
      throw new ContentRegistrationError(
        `Release ${releaseId} is already registered with different immutable ` +
          "metadata/checksums — refusing to silently overwrite it",
      );
    }
    await tx
      .update(contentVersions)
      .set({
        releaseStatus: entry.status,
        minimumSupportedClientVersion: entry.minimum_supported_client_version,
        minimumSupportedEventSchema: entry.minimum_supported_event_schema,
      })
      .where(eq(contentVersions.releaseId, releaseId));
    return;
  }

  await tx.insert(contentVersions).values({
    releaseId,
    contentVersion: verified.contentVersion,
    schemaVersion: verified.schemaVersion,
    questionGeneratorVersion: verified.questionGeneratorVersion,
    entryCount: verified.entryCount,
    checksumLearner: verified.checksums.learner,
    checksumValidation: verified.checksums.validation,
    checksumAssessment: verified.checksums.assessment,
    releaseStatus: entry.status,
    minimumSupportedClientVersion: entry.minimum_supported_client_version,
    minimumSupportedEventSchema: entry.minimum_supported_event_schema,
  });
}

export async function registerContent(
  db: Database = getDb(),
  options: RegisterContentOptions = {},
): Promise<{ registered: string[] }> {
  const registry = await readRegistry(options.registryDir);

  // The active release is always processed last: content_versions enforces
  // at most one 'active' row via a partial unique index, and the registry
  // schema already guarantees exactly one active entry. Updating any
  // currently-active row to its (non-active) registry status BEFORE
  // promoting the new active release avoids a transient uniqueness
  // violation within the same transaction. See the note beside
  // `content_versions_single_active_idx` in db/schema/content.ts.
  const entries = Object.entries(registry.releases);
  const orderedEntries = [
    ...entries.filter(([id]) => id !== registry.active_release_id),
    ...entries.filter(([id]) => id === registry.active_release_id),
  ];

  // Verify every release before opening the transaction — file reads and
  // Zod parsing must never hold a DB transaction (or a row/advisory lock)
  // open for their duration. A verification failure here means nothing is
  // written at all, which is at least as strong an all-or-nothing
  // guarantee as failing mid-transaction would have been.
  const verifiedEntries: Array<
    [releaseId: string, entry: RegistryEntry, verified: VerifiedRelease]
  > = [];
  for (const [releaseId, entry] of orderedEntries) {
    const verified = await loadAndVerifyRelease(releaseId, options);
    verifiedEntries.push([releaseId, entry, verified]);
  }

  const registered: string[] = [];
  await db.transaction(async (tx) => {
    for (const [releaseId, entry, verified] of verifiedEntries) {
      await registerRelease(tx, releaseId, entry, verified);
      registered.push(releaseId);
    }
  });

  return { registered };
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  import("@/db/load-env")
    .then(() => registerContent())
    .then(async (result) => {
      console.log(
        `Registered ${result.registered.length} release(s): ${result.registered.join(", ")}`,
      );
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error("Content registration failed:", error);
      await closeDb();
      process.exit(1);
    });
}
