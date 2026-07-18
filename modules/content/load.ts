/**
 * Client content loader: pointer fetch -> verified cache check -> verified
 * download -> transactional cache -> typed result. Every cache use is
 * cryptographically re-verified (see db.ts); a corrupted cache is treated
 * as unavailable — if the network works it is cleanly redownloaded, and if
 * not, a typed failure is returned rather than corrupted content.
 *
 * Fallback terminology: `fallback-cache` means "the previous verified
 * cached release is being used", with a typed reason. It is only an
 * *offline* situation when the reason is pointer-unavailable or
 * download-failed.
 *
 * BROWSER-ONLY (fetch + Web Crypto + IndexedDB).
 */
import { ACTIVE_POINTER_URL } from "@/modules/content/constants";
import {
  cacheLearnerRelease,
  getSafwaDb,
  readVerifiedActiveCachedRelease,
  readVerifiedCachedRelease,
  type SafwaDb,
} from "@/modules/content/db";
import {
  activePointerSchema,
  type ActivePointer,
  type LearnerEntry,
} from "@/modules/content/schema";
import { sha256HexBrowser } from "@/modules/content/sha256-browser";

export type ContentSource = "network" | "cache" | "fallback-cache";

export type FallbackReason =
  | "pointer-unavailable"
  | "download-failed"
  | "checksum-mismatch"
  | "invalid-release"
  | "pointer-mismatch";

/** Reasons that genuinely indicate the network/pointer was unreachable. */
export const OFFLINE_REASONS: readonly FallbackReason[] = [
  "pointer-unavailable",
  "download-failed",
];

export type LoadContentSuccess = {
  ok: true;
  source: ContentSource;
  /** Present when source is "fallback-cache". */
  fallbackReason?: FallbackReason;
  releaseId: string;
  contentVersion: string;
  questionGeneratorVersion: string;
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
  /** Detailed diagnostics for logging/tests — never shown to end users. */
  message: string;
};

export type LoadContentResult = LoadContentSuccess | LoadContentFailure;

export { sha256HexBrowser } from "@/modules/content/sha256-browser";

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

function success(
  cached: {
    release: {
      releaseId: string;
      contentVersion: string;
      questionGeneratorVersion: string;
      entryCount: number;
    };
    entries: LearnerEntry[];
  },
  source: ContentSource,
  fallbackReason?: FallbackReason,
): LoadContentSuccess {
  return {
    ok: true,
    source,
    ...(fallbackReason ? { fallbackReason } : {}),
    releaseId: cached.release.releaseId,
    contentVersion: cached.release.contentVersion,
    questionGeneratorVersion: cached.release.questionGeneratorVersion,
    entryCount: cached.release.entryCount,
    entries: cached.entries,
  };
}

async function fallbackToVerifiedCache(
  db: SafwaDb,
  reason: FallbackReason,
  failure: LoadContentFailure,
): Promise<LoadContentResult> {
  const cached = await readVerifiedActiveCachedRelease(db);
  if (cached) return success(cached, "fallback-cache", reason);
  return failure;
}

/**
 * Load the active learner content. Flow: fetch + validate the pointer; use
 * the matching cached release when it fully re-verifies against the
 * pointer checksum; otherwise download the learner text, verify SHA-256
 * over the exact bytes, validate, confirm pointer agreement, and cache
 * transactionally. A corrupt matching cache triggers a clean redownload.
 */
export async function loadActiveContent(
  db: SafwaDb = getSafwaDb(),
): Promise<LoadContentResult> {
  let pointer: ActivePointer;
  try {
    pointer = await fetchActiveReleasePointer();
  } catch (error) {
    return fallbackToVerifiedCache(db, "pointer-unavailable", {
      ok: false,
      code: "no-content-available",
      message: `content pointer unavailable and no verified cache exists (${String(error)})`,
    });
  }

  // Verified cache for this exact release + pointer checksum: no download.
  // A corrupt cache returns null here and falls through to redownload.
  const cached = await readVerifiedCachedRelease(
    db,
    pointer.release_id,
    pointer.learner_sha256,
  );
  if (cached) {
    return success(cached, "cache");
  }

  let text: string;
  try {
    text = await fetchLearnerReleaseText(pointer);
  } catch (error) {
    return fallbackToVerifiedCache(db, "download-failed", {
      ok: false,
      code: "no-content-available",
      message: `learner download failed and no verified cache exists (${String(error)})`,
    });
  }

  const digest = await sha256HexBrowser(text);
  if (digest !== pointer.learner_sha256) {
    return fallbackToVerifiedCache(db, "checksum-mismatch", {
      ok: false,
      code: "checksum-mismatch",
      message: `learner checksum mismatch (expected ${pointer.learner_sha256}, computed ${digest})`,
    });
  }

  // Pointer agreement is checked BEFORE caching so a mismatched release is
  // never activated (and can never masquerade as its own fallback).
  let downloadedMeta: {
    release_id?: unknown;
    entry_count?: unknown;
    content_version?: unknown;
  };
  try {
    downloadedMeta = JSON.parse(text) as typeof downloadedMeta;
  } catch (error) {
    return fallbackToVerifiedCache(db, "invalid-release", {
      ok: false,
      code: "invalid-release",
      message: `learner release is not JSON (${String(error)})`,
    });
  }
  if (
    downloadedMeta.release_id !== pointer.release_id ||
    downloadedMeta.entry_count !== pointer.entry_count ||
    downloadedMeta.content_version !== pointer.content_version
  ) {
    return fallbackToVerifiedCache(db, "pointer-mismatch", {
      ok: false,
      code: "pointer-invalid",
      message: "learner release metadata disagrees with the active pointer",
    });
  }

  // cacheLearnerRelease re-verifies bytes + strict schema before writing.
  let release;
  try {
    release = await cacheLearnerRelease(db, text, pointer.learner_sha256);
  } catch (error) {
    return fallbackToVerifiedCache(db, "invalid-release", {
      ok: false,
      code: "invalid-release",
      message: `learner release failed validation (${String(error)})`,
    });
  }

  return {
    ok: true,
    source: "network",
    releaseId: release.release_id,
    contentVersion: release.content_version,
    questionGeneratorVersion: release.question_generator_version,
    entryCount: release.entry_count,
    entries: release.entries,
  };
}
