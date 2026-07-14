/**
 * Client content loader: pointer fetch -> cache check -> verified download
 * -> transactional cache -> typed result. Falls back to the last valid
 * cached release when the network or a download is unavailable, and never
 * activates a release whose checksum or schema fails.
 *
 * BROWSER-ONLY (fetch + Web Crypto + IndexedDB).
 */
import { ACTIVE_POINTER_URL } from "@/modules/content/constants";
import {
  cacheLearnerRelease,
  getContentDb,
  readActiveCachedRelease,
  readCachedRelease,
  type SafwaContentDb,
} from "@/modules/content/db";
import {
  activePointerSchema,
  learnerReleaseSchema,
  type ActivePointer,
  type LearnerEntry,
} from "@/modules/content/schema";

export type ContentSource = "network" | "cache" | "offline-fallback";

export type LoadContentSuccess = {
  ok: true;
  source: ContentSource;
  releaseId: string;
  contentVersion: string;
  entryCount: number;
  entries: LearnerEntry[];
};

export type LoadContentFailure = {
  ok: false;
  code:
    | "no-content-available"
    | "checksum-mismatch"
    | "invalid-release"
    | "pointer-invalid";
  message: string;
};

export type LoadContentResult = LoadContentSuccess | LoadContentFailure;

/** Lowercase-hex SHA-256 of the exact UTF-8 bytes, via Web Crypto. */
export async function sha256HexBrowser(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchActiveReleasePointer(): Promise<ActivePointer> {
  const response = await fetch(ACTIVE_POINTER_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`active pointer fetch failed: HTTP ${response.status}`);
  }
  return activePointerSchema.parse(await response.json());
}

/** Fetch the learner artifact as raw text (checksummed before parsing). */
export async function fetchLearnerReleaseText(
  pointer: ActivePointer,
): Promise<string> {
  const response = await fetch(pointer.learner_url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`learner fetch failed: HTTP ${response.status}`);
  }
  return response.text();
}

function fromCache(
  cached: NonNullable<Awaited<ReturnType<typeof readCachedRelease>>>,
  source: ContentSource,
): LoadContentSuccess {
  return {
    ok: true,
    source,
    releaseId: cached.release.releaseId,
    contentVersion: cached.release.contentVersion,
    entryCount: cached.release.entryCount,
    entries: cached.entries,
  };
}

async function fallbackToCache(
  db: SafwaContentDb,
  failure: LoadContentFailure,
): Promise<LoadContentResult> {
  const cached = await readActiveCachedRelease(db);
  if (cached) return fromCache(cached, "offline-fallback");
  return failure;
}

/**
 * Load the active learner content. Flow: fetch + validate the pointer; use
 * the matching cached release when its checksum agrees; otherwise download
 * the learner text, verify SHA-256 over the exact bytes, parse + validate,
 * confirm it matches the pointer, cache transactionally, then activate.
 */
export async function loadActiveContent(
  db: SafwaContentDb = getContentDb(),
): Promise<LoadContentResult> {
  let pointer: ActivePointer;
  try {
    pointer = await fetchActiveReleasePointer();
  } catch (error) {
    return fallbackToCache(db, {
      ok: false,
      code: "no-content-available",
      message: `content pointer unavailable and no valid cache exists (${String(error)})`,
    });
  }

  // Valid cache for this exact release + checksum: no download needed.
  const cached = await readCachedRelease(db, pointer.release_id);
  if (cached && cached.release.learnerChecksum === pointer.learner_sha256) {
    return fromCache(cached, "cache");
  }

  let text: string;
  try {
    text = await fetchLearnerReleaseText(pointer);
  } catch (error) {
    return fallbackToCache(db, {
      ok: false,
      code: "no-content-available",
      message: `learner download failed and no valid cache exists (${String(error)})`,
    });
  }

  const digest = await sha256HexBrowser(text);
  if (digest !== pointer.learner_sha256) {
    return fallbackToCache(db, {
      ok: false,
      code: "checksum-mismatch",
      message: `learner checksum mismatch (expected ${pointer.learner_sha256}, computed ${digest})`,
    });
  }

  let release;
  try {
    release = learnerReleaseSchema.parse(JSON.parse(text));
  } catch (error) {
    return fallbackToCache(db, {
      ok: false,
      code: "invalid-release",
      message: `learner release failed validation (${String(error)})`,
    });
  }

  if (
    release.release_id !== pointer.release_id ||
    release.entry_count !== pointer.entry_count ||
    release.content_version !== pointer.content_version
  ) {
    return fallbackToCache(db, {
      ok: false,
      code: "pointer-invalid",
      message: "learner release metadata disagrees with the active pointer",
    });
  }

  await cacheLearnerRelease(db, release, digest);
  return {
    ok: true,
    source: "network",
    releaseId: release.release_id,
    contentVersion: release.content_version,
    entryCount: release.entry_count,
    entries: release.entries,
  };
}
