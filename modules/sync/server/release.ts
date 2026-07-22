/**
 * Phase 16 — server-side release resolution for ingestion (§8.3, §10).
 *
 * Validates a submitted event/attempt against the EXACT release it references,
 * not merely the currently-active one: a supported (older) release must remain
 * ingestible, while a revoked or unknown release yields a safe, recoverable
 * per-item rejection. Manifests are loaded through the cached, checksum-verified
 * loader so a batch never re-hashes the same release's artifacts per item.
 */
import "server-only";

import type { VerifiedRelease } from "@/modules/content/server-manifests";
import {
  loadVerifiedReleaseCached,
  readRegistry,
} from "@/modules/content/server-release-registry";
import type { SyncReasonCode } from "@/modules/sync/protocol";

/** Test-only overrides for the registry and artifact roots (NODE_ENV=test). */
export type ReleaseLoadOptions = {
  registryDir?: string;
  contentServerDir?: string;
  publicContentDir?: string;
};

export type ReleaseResolution =
  | { ok: true; release: VerifiedRelease; status: "active" | "supported" }
  | {
      ok: false;
      reasonCode: Extract<
        SyncReasonCode,
        "invalid_release" | "revoked_release"
      >;
    };

/** Statuses whose events may still be ingested (§8.3). */
const INGESTIBLE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "supported",
]);

/**
 * Resolve the release a submitted item references. Rejects (recoverably) an
 * unknown release (`invalid_release`) or a revoked one (`revoked_release`)
 * BEFORE loading any manifest; otherwise returns the verified release.
 */
export async function resolveReleaseForIngestion(
  releaseId: string,
  options: ReleaseLoadOptions = {},
): Promise<ReleaseResolution> {
  let registry;
  try {
    registry = await readRegistry(options.registryDir);
  } catch (error) {
    // A broken/unreadable registry is a server-side dependency failure; treat
    // the item as recoverably rejected rather than leaking the cause to the
    // client — but ALWAYS leave a server-side trace (a malformed registry is a
    // first-class monitoring signal, ARCHITECTURE.md §8), never a silent drop.
    console.error(
      `[sync] release resolution: registry read failed for ${releaseId}`,
      error,
    );
    return { ok: false, reasonCode: "invalid_release" };
  }

  const entry = registry.releases[releaseId];
  if (!entry) {
    return { ok: false, reasonCode: "invalid_release" };
  }
  if (entry.status === "revoked") {
    return { ok: false, reasonCode: "revoked_release" };
  }
  if (!INGESTIBLE_STATUSES.has(entry.status)) {
    return { ok: false, reasonCode: "invalid_release" };
  }

  try {
    const release = await loadVerifiedReleaseCached(releaseId, {
      contentServerDir: options.contentServerDir,
      publicContentDir: options.publicContentDir,
    });
    return {
      ok: true,
      release,
      status: entry.status as "active" | "supported",
    };
  } catch (error) {
    // Artifact verification failure (missing/tampered manifest, checksum
    // mismatch) — recoverable for the client, but a checksum mismatch is a
    // tamper/broken-build signal that MUST be surfaced server-side, never
    // collapsed silently into the same code as an unknown release id.
    console.error(
      `[sync] release resolution: manifest load/verify failed for ${releaseId}`,
      error,
    );
    return { ok: false, reasonCode: "invalid_release" };
  }
}
