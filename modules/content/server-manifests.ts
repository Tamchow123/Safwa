/**
 * Server-only content-manifest loader (Phase 15, phases-15.md §28). Loads
 * and fully verifies one release's three artifacts — the public learner
 * release plus the server-only validation and assessment manifests — never
 * normalising or reserialising bytes before checksum verification. Fails
 * closed on any checksum mismatch, cross-artifact identity mismatch,
 * unknown field, or missing/unreadable file. Never import this from
 * browser code — the assessment manifest is the server-side trust
 * boundary (ADR-006) and must never reach a client bundle.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256HexUtf8 } from "@/modules/content/checksum";
import {
  assessmentManifestSchema,
  checksumManifestSchema,
  learnerReleaseSchema,
  validationManifestSchema,
  type AssessmentManifest,
  type LearnerRelease,
  type ValidationManifest,
} from "@/modules/content/schema";
import { getServerEnv } from "@/modules/env/server";

export class ManifestVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestVerificationError";
  }
}

// Alphanumeric plus dot/dash/underscore only, must start with an
// alphanumeric — rejects "..", a leading "/", and any path separator.
const SAFE_RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeReleaseId(releaseId: string): void {
  if (!SAFE_RELEASE_ID_PATTERN.test(releaseId) || releaseId.includes("..")) {
    throw new ManifestVerificationError(
      `Malformed or unsafe release id: ${JSON.stringify(releaseId)}`,
    );
  }
}

/** Resolves a release subdirectory and confirms it cannot escape `root`. */
function resolveReleaseDir(root: string, releaseId: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(resolvedRoot, "releases", releaseId);
  if (
    resolvedDir !== resolvedRoot &&
    !resolvedDir.startsWith(resolvedRoot + path.sep)
  ) {
    throw new ManifestVerificationError(
      `Release path escapes its root directory: ${releaseId}`,
    );
  }
  return resolvedDir;
}

async function readArtifact(
  filePath: string,
  label: string,
  releaseId: string,
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    // Log the absolute path server-side only — the thrown error must never
    // leak filesystem layout to a caller that might forward it to a client.
    console.error(
      `[content] missing or unreadable ${label} at ${filePath}:`,
      error,
    );
    throw new ManifestVerificationError(
      `Missing or unreadable ${label} for release ${releaseId}`,
    );
  }
}

function parseJson(bytes: string, label: string): unknown {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new ManifestVerificationError(
      `Invalid JSON in ${label}: ${(error as Error).message}`,
    );
  }
}

export type VerifiedRelease = {
  releaseId: string;
  contentVersion: string;
  schemaVersion: string;
  questionGeneratorVersion: string;
  entryCount: number;
  learner: LearnerRelease;
  validation: ValidationManifest;
  assessment: AssessmentManifest;
  /** The checksums.json values already verified against the raw bytes above. */
  checksums: {
    learner: string;
    validation: string;
    assessment: string;
  };
};

type ArtifactIdentity = {
  name: string;
  releaseId: string;
  contentVersion: string;
  schemaVersion: string;
  questionGeneratorVersion: string;
  entryCount: number;
};

export type LoadAndVerifyReleaseOptions = {
  /** Overrides `getServerEnv().contentServerDir` — test fixtures only. */
  contentServerDir?: string;
  /** Overrides the default `<cwd>/public/content` root — test fixtures only. */
  publicContentDir?: string;
};

/**
 * These roots are a server-side trust boundary (ADR-006): only test code,
 * running with `NODE_ENV=test`, may redirect them to a fixture directory.
 * Throws instead of silently ignoring the override outside tests, so a
 * future route/config accidentally forwarding a caller-influenced root can
 * never take effect.
 */
function assertOverrideIsTestOnly(options: LoadAndVerifyReleaseOptions): void {
  const overridden =
    options.contentServerDir !== undefined ||
    options.publicContentDir !== undefined;
  if (overridden && process.env.NODE_ENV !== "test") {
    throw new ManifestVerificationError(
      "contentServerDir/publicContentDir overrides are only permitted when NODE_ENV=test",
    );
  }
}

/**
 * Loads and fully verifies one release by id. Every step fails closed: a
 * checksum mismatch, a cross-artifact identity mismatch, an unknown field
 * (strict Zod schemas), or a missing file all reject with
 * `ManifestVerificationError` rather than silently degrading.
 *
 * `options` exists so fixture-based tests can point both roots at a
 * throwaway directory instead of the real `content-server`/`public/content`
 * — production call sites never pass it, and `assertOverrideIsTestOnly`
 * enforces that the override can only ever take effect under `NODE_ENV=test`.
 */
export async function loadAndVerifyRelease(
  releaseId: string,
  options: LoadAndVerifyReleaseOptions = {},
): Promise<VerifiedRelease> {
  assertSafeReleaseId(releaseId);
  assertOverrideIsTestOnly(options);

  const serverRoot =
    options.contentServerDir ?? getServerEnv().contentServerDir;
  const publicRoot =
    options.publicContentDir ?? path.join(process.cwd(), "public", "content");
  const serverDir = resolveReleaseDir(serverRoot, releaseId);
  const publicDir = resolveReleaseDir(publicRoot, releaseId);

  const [learnerBytes, validationBytes, assessmentBytes, checksumsBytes] =
    await Promise.all([
      readArtifact(
        path.join(publicDir, "learner.json"),
        "learner.json",
        releaseId,
      ),
      readArtifact(
        path.join(serverDir, "validation.json"),
        "validation.json",
        releaseId,
      ),
      readArtifact(
        path.join(serverDir, "assessment.json"),
        "assessment.json",
        releaseId,
      ),
      readArtifact(
        path.join(serverDir, "checksums.json"),
        "checksums.json",
        releaseId,
      ),
    ]);

  const checksumsResult = checksumManifestSchema.safeParse(
    parseJson(checksumsBytes, "checksums.json"),
  );
  if (!checksumsResult.success) {
    throw new ManifestVerificationError(
      `Invalid checksums.json for release ${releaseId}: ${checksumsResult.error.message}`,
    );
  }
  const checksums = checksumsResult.data;
  if (checksums.release_id !== releaseId) {
    throw new ManifestVerificationError(
      `checksums.json release_id ${checksums.release_id} does not match requested ${releaseId}`,
    );
  }

  const actual = {
    learner: sha256HexUtf8(learnerBytes),
    validation: sha256HexUtf8(validationBytes),
    assessment: sha256HexUtf8(assessmentBytes),
  };
  for (const key of ["learner", "validation", "assessment"] as const) {
    if (actual[key] !== checksums[key]) {
      throw new ManifestVerificationError(
        `${key}.json checksum mismatch for release ${releaseId}`,
      );
    }
  }

  const learnerResult = learnerReleaseSchema.safeParse(
    parseJson(learnerBytes, "learner.json"),
  );
  if (!learnerResult.success) {
    throw new ManifestVerificationError(
      `Invalid learner.json for release ${releaseId}: ${learnerResult.error.message}`,
    );
  }
  const validationResult = validationManifestSchema.safeParse(
    parseJson(validationBytes, "validation.json"),
  );
  if (!validationResult.success) {
    throw new ManifestVerificationError(
      `Invalid validation.json for release ${releaseId}: ${validationResult.error.message}`,
    );
  }
  const assessmentResult = assessmentManifestSchema.safeParse(
    parseJson(assessmentBytes, "assessment.json"),
  );
  if (!assessmentResult.success) {
    throw new ManifestVerificationError(
      `Invalid assessment.json for release ${releaseId}: ${assessmentResult.error.message}`,
    );
  }

  const learner = learnerResult.data;
  const validation = validationResult.data;
  const assessment = assessmentResult.data;

  const identities: ArtifactIdentity[] = [
    {
      name: "learner",
      releaseId: learner.release_id,
      contentVersion: learner.content_version,
      schemaVersion: learner.schema_version,
      questionGeneratorVersion: learner.question_generator_version,
      entryCount: learner.entry_count,
    },
    {
      name: "validation",
      releaseId: validation.release_id,
      contentVersion: validation.content_version,
      schemaVersion: validation.schema_version,
      questionGeneratorVersion: validation.question_generator_version,
      entryCount: validation.entry_count,
    },
    {
      name: "assessment",
      releaseId: assessment.release_id,
      contentVersion: assessment.content_version,
      schemaVersion: assessment.schema_version,
      questionGeneratorVersion: assessment.question_generator_version,
      entryCount: assessment.entry_count,
    },
  ];
  const [first, ...rest] = identities as [
    ArtifactIdentity,
    ...ArtifactIdentity[],
  ];
  for (const artifact of rest) {
    if (
      artifact.releaseId !== first.releaseId ||
      artifact.contentVersion !== first.contentVersion ||
      artifact.schemaVersion !== first.schemaVersion ||
      artifact.questionGeneratorVersion !== first.questionGeneratorVersion ||
      artifact.entryCount !== first.entryCount
    ) {
      throw new ManifestVerificationError(
        `Cross-artifact identity mismatch: ${artifact.name} disagrees with learner for release ${releaseId}`,
      );
    }
  }
  if (first.releaseId !== releaseId) {
    throw new ManifestVerificationError(
      `Artifact release_id ${first.releaseId} does not match requested ${releaseId}`,
    );
  }

  return {
    releaseId: first.releaseId,
    contentVersion: first.contentVersion,
    schemaVersion: first.schemaVersion,
    questionGeneratorVersion: first.questionGeneratorVersion,
    entryCount: first.entryCount,
    learner,
    validation,
    assessment,
    checksums: actual,
  };
}
