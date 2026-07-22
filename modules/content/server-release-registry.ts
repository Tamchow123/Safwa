/**
 * Server-only release-registry reading and active-release resolution
 * (Phase 15, phases-15.md §28). Two responsibilities live here: `readRegistry`
 * (exported for db/register-content.ts, which must process EVERY listed
 * release, not just the active one) reads and validates the mutable
 * `release-registry.json`; `getActiveRelease` builds on it to resolve and
 * cache the single active release.
 *
 * Reads `release-registry.json` fresh on every call (it is small and must
 * reflect a live status change immediately — e.g. a release just revoked),
 * but caches each individually-verified release's full content in-process,
 * keyed by release id, ONLY after `loadAndVerifyRelease` has fully
 * succeeded. Concurrent callers for the same release id share one
 * in-flight promise (coalesced, not re-verified per caller). A failed load
 * is never cached as a success.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  releaseRegistrySchema,
  type ReleaseRegistry,
} from "@/modules/content/schema";
import {
  loadAndVerifyRelease,
  ManifestVerificationError,
  type LoadAndVerifyReleaseOptions,
  type VerifiedRelease,
} from "@/modules/content/server-manifests";
import { getServerEnv } from "@/modules/env/server";

/**
 * `registryDir` is a server-side trust boundary override — only test code,
 * running with `NODE_ENV=test`, may redirect it to a fixture directory.
 */
function assertRegistryOverrideIsTestOnly(
  registryDir: string | undefined,
): void {
  if (registryDir !== undefined && process.env.NODE_ENV !== "test") {
    throw new ManifestVerificationError(
      "registryDir override is only permitted when NODE_ENV=test",
    );
  }
}

/**
 * Reads and validates the full release registry (every listed release, not
 * just the active one) — exported for `db/register-content.ts`, which must
 * register every release the registry lists, not merely the active one.
 */
export async function readRegistry(
  registryDir?: string,
): Promise<ReleaseRegistry> {
  assertRegistryOverrideIsTestOnly(registryDir);
  const root = registryDir ?? getServerEnv().contentServerDir;
  const registryPath = path.join(path.resolve(root), "release-registry.json");
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (error) {
    // Log the absolute path server-side only — never leak it in a thrown
    // error that a future route handler might forward to a client.
    console.error(
      `[content] cannot read release registry at ${registryPath}:`,
      error,
    );
    throw new ManifestVerificationError("Cannot read release registry");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new ManifestVerificationError(
      `Invalid JSON in release registry: ${(error as Error).message}`,
    );
  }
  const result = releaseRegistrySchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ManifestVerificationError(
      `Invalid release registry: ${result.error.message}`,
    );
  }
  return result.data;
}

const verifiedReleaseCache = new Map<string, Promise<VerifiedRelease>>();

/**
 * Verified-release cache keyed by release id. The promise is stored
 * BEFORE awaiting it, so concurrent calls for the same id coalesce onto
 * the same in-flight verification instead of re-reading/re-hashing the
 * artifacts once per caller.
 */
function loadVerifiedReleaseCached(
  releaseId: string,
  options: LoadAndVerifyReleaseOptions,
): Promise<VerifiedRelease> {
  const existing = verifiedReleaseCache.get(releaseId);
  if (existing) return existing;
  const promise = loadAndVerifyRelease(releaseId, options).catch(
    (error: unknown) => {
      // Never cache a failed load as if it were a success.
      verifiedReleaseCache.delete(releaseId);
      throw error;
    },
  );
  verifiedReleaseCache.set(releaseId, promise);
  return promise;
}

export type GetActiveReleaseOptions = LoadAndVerifyReleaseOptions & {
  /** Overrides `getServerEnv().contentServerDir` for the registry itself — test fixtures only. */
  registryDir?: string;
};

/**
 * Resolves and returns the currently-active, fully-verified release.
 * Fails closed when the registry is invalid, the active release is
 * missing, more than one release is active (the registry schema itself
 * already enforces this), or the active release's own artifacts fail
 * verification (checksum mismatch, cross-artifact disagreement, unknown
 * fields, revoked status).
 *
 * `options` exists so fixture-based tests can point the registry and
 * artifact roots at a throwaway directory — production call sites never
 * pass it, and `assertRegistryOverrideIsTestOnly`/`assertOverrideIsTestOnly`
 * enforce that the override can only ever take effect under `NODE_ENV=test`.
 */
export async function getActiveRelease(
  options: GetActiveReleaseOptions = {},
): Promise<VerifiedRelease> {
  const registry = await readRegistry(options.registryDir);
  const activeEntry = registry.releases[registry.active_release_id];
  if (!activeEntry) {
    throw new ManifestVerificationError(
      `Active release ${registry.active_release_id} is not present in the registry`,
    );
  }
  if (activeEntry.status !== "active") {
    throw new ManifestVerificationError(
      `Active release ${registry.active_release_id} has status ${activeEntry.status}, expected active`,
    );
  }
  return loadVerifiedReleaseCached(registry.active_release_id, options);
}

/** Test-only: clear the in-process verified-release cache entirely. */
export function resetServerManifestCacheForTests(): void {
  verifiedReleaseCache.clear();
}

/** Test-only: inject a pre-verified release directly, bypassing disk I/O. */
export function setVerifiedReleaseForTests(
  releaseId: string,
  release: VerifiedRelease,
): void {
  verifiedReleaseCache.set(releaseId, Promise.resolve(release));
}
