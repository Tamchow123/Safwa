/**
 * Content-release build: reads the validated enriched dataset (the sole
 * content-authoring authority, see ADR-003) and emits the immutable release
 * artifacts:
 *
 *   public/content/releases/<release-id>/learner.json   (public)
 *   public/content/active.json                          (public pointer)
 *   content-server/releases/<release-id>/validation.json (server-only)
 *   content-server/releases/<release-id>/assessment.json (server-only)
 *   content-server/releases/<release-id>/checksums.json  (server-only)
 *
 * NODE-ONLY entry point (`pnpm content:build`); the pure builder
 * (buildArtifacts) is imported by tests. Determinism: stable key order,
 * `created_at` taken from the dataset's own generated_at (never wall-clock),
 * release id derived from a content hash — identical input produces
 * byte-identical artifacts.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sha256HexUtf8 } from "@/modules/content/checksum";
import {
  ACTIVE_POINTER_URL,
  ANSWER_FIELDS,
  COMPONENT_SHAPES,
  DIRECTIONS,
  EXPECTED_BAB_COUNTS,
  EXPECTED_DUPLICATE_MADI_GROUPS,
  EXPECTED_ELIGIBILITY_COUNTS,
  EXPECTED_ENTRY_COUNT,
  learnerUrlForRelease,
  MINIMUM_SUPPORTED_CLIENT_VERSION,
  MINIMUM_SUPPORTED_EVENT_SCHEMA,
  QUESTION_GENERATOR_VERSION,
  RELEASE_ID_HASH_LENGTH,
  RELEASE_ID_PREFIX,
  SKILL_METADATA,
  SKILL_TYPES,
  SOURCE_QUIZ_FORM_FIELDS,
  UNRESOLVED_ROOT_ENTRY_IDS,
  type AnswerField,
} from "@/modules/content/constants";
import {
  activePointerSchema,
  assessmentManifestSchema,
  checksumManifestSchema,
  learnerReleaseSchema,
  releaseRegistrySchema,
  validationManifestSchema,
  type ActivePointer,
  type ReleaseRegistry,
  type AssessmentManifest,
  type ChecksumManifest,
  type LearnerEntry,
  type LearnerRelease,
  type ValidationManifest,
} from "@/modules/content/schema";
import {
  sourceDatasetSchema,
  type SourceDataset,
  type SourceEntry,
} from "@/modules/content/source-schema";
import {
  serializeArtifact,
  stableStringify,
} from "@/modules/content/stable-json";

export class ContentBuildError extends Error {}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContentBuildError(`release-safety invariant failed: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Invariants                                                          */
/* ------------------------------------------------------------------ */

function assertSourceInvariants(source: SourceDataset): void {
  const entries = source.mujarrad_entries;
  invariant(
    entries.length === EXPECTED_ENTRY_COUNT,
    `expected ${EXPECTED_ENTRY_COUNT} entries, found ${entries.length}`,
  );
  invariant(
    source.statistics.mujarrad_entry_count === EXPECTED_ENTRY_COUNT,
    "statistics.mujarrad_entry_count mismatch",
  );

  // Eligibility counts: computed from entries AND cross-checked against the
  // dataset's own statistics. Eligibility is copied from approved metadata;
  // presence of a value never implies eligibility.
  for (const [field, expected] of Object.entries(EXPECTED_ELIGIBILITY_COUNTS)) {
    const computed = entries.filter(
      (entry) =>
        entry.quiz_eligibility[
          field as keyof typeof EXPECTED_ELIGIBILITY_COUNTS
        ] === true,
    ).length;
    invariant(
      computed === expected,
      `eligibility count for ${field}: expected ${expected}, computed ${computed}`,
    );
    const stat =
      source.statistics.quiz_eligibility_statistics[`${field}_eligible`];
    invariant(
      stat === expected,
      `statistics eligibility for ${field}: expected ${expected}, recorded ${String(stat)}`,
    );
  }

  // A quiz-eligible field must have an approved non-empty value.
  for (const entry of entries) {
    for (const field of [...SOURCE_QUIZ_FORM_FIELDS, "meaning"] as const) {
      if (entry.quiz_eligibility[field]) {
        invariant(
          entry[field].trim().length > 0,
          `entry ${entry.id}: eligible field ${field} has an empty value`,
        );
      }
    }
    if (entry.quiz_eligibility.root) {
      invariant(
        entry.root.trim().length > 0,
        `entry ${entry.id}: eligible root is empty`,
      );
    }
  }

  // Unresolved roots (369, 372) stay root- and verb-type-ineligible.
  for (const id of UNRESOLVED_ROOT_ENTRY_IDS) {
    const entry = entries.find((candidate) => candidate.id === id);
    invariant(entry !== undefined, `unresolved-root entry ${id} missing`);
    invariant(
      entry.quiz_eligibility.root === false &&
        entry.quiz_eligibility.verb_type === false,
      `entry ${id} must remain root/verb_type quiz-ineligible`,
    );
    invariant(
      entry.data_quality.root_status === "needs_review",
      `entry ${id} root_status must be needs_review`,
    );
  }

  // No generated additional form may be quiz-eligible; none ships anywhere.
  for (const entry of entries) {
    invariant(
      entry.quiz_eligibility.generated_additional_forms === false,
      `entry ${entry.id}: generated_additional_forms must be ineligible`,
    );
    for (const cellName of [
      "ism_maful",
      "madi_passive",
      "mudari_passive",
    ] as const) {
      invariant(
        entry.additional_forms[cellName].quiz_eligible === false,
        `entry ${entry.id}: generated form ${cellName} is marked quiz-eligible`,
      );
    }
  }

  // Mazid candidates are all quiz-ineligible and excluded from releases.
  for (const candidate of source.mazid_fih_entries) {
    invariant(
      candidate.quiz_eligible === false,
      `mazid candidate ${candidate.id} is marked quiz-eligible`,
    );
  }

  // Bab distribution.
  for (const [bab, expected] of Object.entries(EXPECTED_BAB_COUNTS)) {
    const computed = entries.filter((entry) => entry.bab === bab).length;
    invariant(
      computed === expected,
      `bab ${bab}: expected ${expected} entries, computed ${computed}`,
    );
  }

  // Protected duplicate-madi groups stay distinct with distinct mudari.
  const byMadi = new Map<string, number[]>();
  for (const entry of entries) {
    byMadi.set(entry.madi, [...(byMadi.get(entry.madi) ?? []), entry.id]);
  }
  const duplicateGroups = [...byMadi.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => [...ids].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
  invariant(
    stableStringify(duplicateGroups) ===
      stableStringify(
        EXPECTED_DUPLICATE_MADI_GROUPS.map((group) => [...group]),
      ),
    `duplicate-madi groups changed: ${JSON.stringify(duplicateGroups)}`,
  );
  for (const group of duplicateGroups) {
    const mudariValues = new Set(
      group.map(
        (id) => entries.find((candidate) => candidate.id === id)!.mudari,
      ),
    );
    invariant(
      mudariValues.size === group.length,
      `duplicate group ${JSON.stringify(group)} lost distinct mudari values`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Artifact construction (explicit allowlists — never object spread)   */
/* ------------------------------------------------------------------ */

function buildLearnerEntry(entry: SourceEntry): LearnerEntry {
  const learnerEntry: LearnerEntry = {
    id: entry.id,
    madi: entry.madi,
    mudari: entry.mudari,
    masdar: entry.masdar,
    meaning: entry.meaning,
    ism_fail: entry.ism_fail,
    amr: entry.amr,
    nahi: entry.nahi,
    bab: entry.bab,
    bab_arabic: entry.bab_arabic,
    verb_type: entry.verb_type,
    verb_type_arabic: entry.verb_type_arabic,
    book_page: entry.book_page,
    quiz_eligibility: {
      madi: entry.quiz_eligibility.madi,
      mudari: entry.quiz_eligibility.mudari,
      masdar: entry.quiz_eligibility.masdar,
      meaning: entry.quiz_eligibility.meaning,
      ism_fail: entry.quiz_eligibility.ism_fail,
      amr: entry.quiz_eligibility.amr,
      nahi: entry.quiz_eligibility.nahi,
      bab: entry.quiz_eligibility.bab,
      verb_type: entry.quiz_eligibility.verb_type,
      root: entry.quiz_eligibility.root,
    },
  };
  // The root is displayed only while internally validated (= eligible);
  // unresolved proposals (369, 372) are not learner-display-safe claims.
  if (entry.quiz_eligibility.root) {
    learnerEntry.root = entry.root;
  }
  if (entry.transcription_note) {
    learnerEntry.transcription_note = entry.transcription_note;
  }
  return learnerEntry;
}

function buildAssessmentAnswers(
  entry: SourceEntry,
): Partial<Record<AnswerField, string>> {
  const answers: Partial<Record<AnswerField, string>> = {};
  for (const field of SOURCE_QUIZ_FORM_FIELDS) {
    if (entry.quiz_eligibility[field]) answers[field] = entry[field];
  }
  if (entry.quiz_eligibility.meaning) answers.meaning = entry.meaning;
  if (entry.quiz_eligibility.root) answers.root = entry.root;
  if (entry.quiz_eligibility.bab) answers.bab = entry.bab;
  if (entry.quiz_eligibility.verb_type) answers.verb_type = entry.verb_type;
  return answers;
}

export type BuiltArtifacts = {
  releaseId: string;
  learner: LearnerRelease;
  validation: ValidationManifest;
  assessment: AssessmentManifest;
  checksums: ChecksumManifest;
  activePointer: ActivePointer;
  serialized: {
    learner: string;
    validation: string;
    assessment: string;
    checksums: string;
    activePointer: string;
  };
  excludedGeneratedFormValues: number;
  excludedMazidCandidates: number;
};

/**
 * Release identity: `safwa-<content_version>-<hash16>` where hash16 is the
 * first RELEASE_ID_HASH_LENGTH hex chars of the SHA-256 of the
 * deterministic serialization of the FULL release basis — every semantic
 * that affects any immutable primary artifact (versions, generator
 * version, learner entries, structural validation rules + skill metadata +
 * per-entry validation metadata, and assessment canonical answers). The
 * `release_id` is then injected into the artifacts.
 *
 * Consequences: any learner/assessment/validation-policy change => new id;
 * a source `generated_at`-only change => same id and identical bytes
 * (timestamps never enter immutable artifacts); operational lifecycle
 * changes live in the release registry and never affect the id.
 *
 * `release_id` is the AUTHORITATIVE exact-release identifier;
 * `content_version` is human-readable metadata only.
 */
export function deriveReleaseIdFromBasis(
  contentVersion: string,
  releaseBasis: unknown,
): string {
  const basisHash = sha256HexUtf8(stableStringify(releaseBasis));
  return `${RELEASE_ID_PREFIX}-${contentVersion}-${basisHash.slice(
    0,
    RELEASE_ID_HASH_LENGTH,
  )}`;
}

/** Pure builder: source JSON text in, fully validated artifacts out. */
export function buildArtifacts(sourceJsonText: string): BuiltArtifacts {
  const source = sourceDatasetSchema.parse(JSON.parse(sourceJsonText));
  assertSourceInvariants(source);

  const contentVersion = source.schema_version;
  const entries = source.mujarrad_entries.map(buildLearnerEntry);

  const skillMetadata = SKILL_METADATA.map((skill) => ({
    id: skill.id,
    component_shape: skill.component_shape,
    allowed_source_fields: [...skill.allowed_source_fields],
    allowed_directions: [...skill.allowed_directions],
  }));

  const validationEntries = source.mujarrad_entries.map((entry) => ({
    entry_id: entry.id,
    eligible_fields: [
      ...SOURCE_QUIZ_FORM_FIELDS.filter(
        (field) => entry.quiz_eligibility[field],
      ),
      ...(entry.quiz_eligibility.meaning ? (["meaning"] as const) : []),
    ],
    bab_id: entry.bab,
    verb_type_id: entry.quiz_eligibility.verb_type ? entry.verb_type : null,
    root_quiz_eligible: entry.quiz_eligibility.root,
    bab_quiz_eligible: entry.quiz_eligibility.bab,
    verb_type_quiz_eligible: entry.quiz_eligibility.verb_type,
  }));

  const assessmentEntries = source.mujarrad_entries.map((entry) => ({
    entry_id: entry.id,
    answers: buildAssessmentAnswers(entry),
  }));

  const releaseBasis = {
    schema_version: source.schema_version,
    content_version: contentVersion,
    question_generator_version: QUESTION_GENERATOR_VERSION,
    learner: { entries },
    validation: {
      allowed_source_fields: [...SOURCE_QUIZ_FORM_FIELDS],
      allowed_directions: [...DIRECTIONS],
      allowed_skill_types: [...SKILL_TYPES],
      valid_component_shapes: [...COMPONENT_SHAPES],
      skill_metadata: skillMetadata,
      entries: validationEntries,
    },
    assessment: { entries: assessmentEntries },
  };
  const releaseId = deriveReleaseIdFromBasis(contentVersion, releaseBasis);

  const learner = learnerReleaseSchema.parse({
    release_id: releaseId,
    schema_version: source.schema_version,
    content_version: contentVersion,
    question_generator_version: QUESTION_GENERATOR_VERSION,
    entry_count: entries.length,
    entries,
  } satisfies LearnerRelease);

  const validation = validationManifestSchema.parse({
    release_id: releaseId,
    schema_version: source.schema_version,
    content_version: contentVersion,
    question_generator_version: QUESTION_GENERATOR_VERSION,
    entry_count: entries.length,
    allowed_source_fields: [...SOURCE_QUIZ_FORM_FIELDS],
    allowed_directions: [...DIRECTIONS],
    allowed_skill_types: [...SKILL_TYPES],
    valid_component_shapes: [...COMPONENT_SHAPES],
    skill_metadata: skillMetadata,
    entries: validationEntries,
  } satisfies ValidationManifest);

  const assessment = assessmentManifestSchema.parse({
    release_id: releaseId,
    schema_version: source.schema_version,
    content_version: contentVersion,
    question_generator_version: QUESTION_GENERATOR_VERSION,
    entry_count: entries.length,
    entries: assessmentEntries,
  } satisfies AssessmentManifest);

  // Cross-artifact safety: canonical answers exist only for eligible fields.
  for (const [index, manifestEntry] of assessment.entries.entries()) {
    const sourceEntry = source.mujarrad_entries[index];
    invariant(
      manifestEntry.entry_id === sourceEntry.id,
      "assessment/source entry order drifted",
    );
    for (const field of Object.keys(manifestEntry.answers)) {
      invariant(
        (ANSWER_FIELDS as readonly string[]).includes(field),
        `assessment entry ${manifestEntry.entry_id}: unknown answer field ${field}`,
      );
    }
  }
  for (const id of UNRESOLVED_ROOT_ENTRY_IDS) {
    const manifestEntry = assessment.entries.find((e) => e.entry_id === id)!;
    invariant(
      !("root" in manifestEntry.answers) &&
        !("verb_type" in manifestEntry.answers),
      `entry ${id} must not expose root/verb_type canonical answers`,
    );
  }

  const serializedLearner = serializeArtifact(learner);
  const serializedValidation = serializeArtifact(validation);
  const serializedAssessment = serializeArtifact(assessment);

  const checksums = checksumManifestSchema.parse({
    algorithm: "sha256",
    release_id: releaseId,
    learner: sha256HexUtf8(serializedLearner),
    validation: sha256HexUtf8(serializedValidation),
    assessment: sha256HexUtf8(serializedAssessment),
  } satisfies ChecksumManifest);

  const activePointer = activePointerSchema.parse({
    release_id: releaseId,
    content_version: contentVersion,
    schema_version: source.schema_version,
    question_generator_version: QUESTION_GENERATOR_VERSION,
    learner_url: learnerUrlForRelease(releaseId),
    learner_sha256: checksums.learner,
    entry_count: entries.length,
  } satisfies ActivePointer);

  return {
    releaseId,
    learner,
    validation,
    assessment,
    checksums,
    activePointer,
    serialized: {
      learner: serializedLearner,
      validation: serializedValidation,
      assessment: serializedAssessment,
      checksums: serializeArtifact(checksums),
      activePointer: serializeArtifact(activePointer),
    },
    excludedGeneratedFormValues:
      source.statistics.generated_additional_form_values,
    excludedMazidCandidates: source.statistics.mazid_fih_candidate_count,
  };
}

/* ------------------------------------------------------------------ */
/* Filesystem entry point                                              */
/* ------------------------------------------------------------------ */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SOURCE_DATASET_PATH = join(
  REPO_ROOT,
  "data",
  "safwa-vocabulary.v2.json",
);
export const PUBLIC_CONTENT_DIR = join(REPO_ROOT, "public", "content");
export const SERVER_CONTENT_DIR = join(REPO_ROOT, "content-server");

/** Atomic replace — for mutable pointer/registry files only. */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Write an IMMUTABLE release file: absent -> atomic write; identical bytes
 * -> idempotent no-op; different bytes -> hard failure. A published release
 * id can never be re-pointed at different content.
 */
export function writeImmutableFile(
  path: string,
  content: string,
): "written" | "unchanged" {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing === content) return "unchanged";
    throw new ContentBuildError(
      `immutable release file already exists with different bytes: ${path}`,
    );
  }
  writeFileAtomic(path, content);
  return "written";
}

/** Upsert this release into the mutable server release registry. */
function updateReleaseRegistry(built: BuiltArtifacts): ReleaseRegistry {
  const registryPath = join(SERVER_CONTENT_DIR, "release-registry.json");
  let registry: ReleaseRegistry = {
    active_release_id: built.releaseId,
    releases: {},
  };
  if (existsSync(registryPath)) {
    registry = releaseRegistrySchema.parse(
      JSON.parse(readFileSync(registryPath, "utf8")),
    );
  }
  const existing = registry.releases[built.releaseId];
  if (existing?.status === "revoked") {
    throw new ContentBuildError(
      `release ${built.releaseId} is revoked and cannot be re-activated`,
    );
  }
  registry.active_release_id = built.releaseId;
  registry.releases[built.releaseId] = {
    status: "active",
    minimum_supported_client_version:
      existing?.minimum_supported_client_version ??
      MINIMUM_SUPPORTED_CLIENT_VERSION,
    minimum_supported_event_schema:
      existing?.minimum_supported_event_schema ??
      MINIMUM_SUPPORTED_EVENT_SCHEMA,
  };
  writeFileAtomic(registryPath, serializeArtifact(registry));
  return registry;
}

export function runContentBuild(): BuiltArtifacts {
  const sourceText = readFileSync(SOURCE_DATASET_PATH, "utf8");
  const built = buildArtifacts(sourceText);

  const learnerPath = join(
    PUBLIC_CONTENT_DIR,
    "releases",
    built.releaseId,
    "learner.json",
  );
  const serverReleaseDir = join(
    SERVER_CONTENT_DIR,
    "releases",
    built.releaseId,
  );

  // Immutable artifacts: never overwritten with different bytes.
  writeImmutableFile(learnerPath, built.serialized.learner);
  writeImmutableFile(
    join(serverReleaseDir, "validation.json"),
    built.serialized.validation,
  );
  writeImmutableFile(
    join(serverReleaseDir, "assessment.json"),
    built.serialized.assessment,
  );
  writeImmutableFile(
    join(serverReleaseDir, "checksums.json"),
    built.serialized.checksums,
  );
  // Mutable pointer + operational registry: atomic replace.
  writeFileAtomic(
    join(PUBLIC_CONTENT_DIR, "active.json"),
    built.serialized.activePointer,
  );
  updateReleaseRegistry(built);

  const eligibility = Object.entries(EXPECTED_ELIGIBILITY_COUNTS)
    .map(([field, count]) => `${field} ${count}`)
    .join(" | ");
  const summary = [
    "content build OK",
    `  release_id     : ${built.releaseId}`,
    `  content/schema : ${built.learner.content_version} / ${built.learner.schema_version}`,
    `  entries        : ${built.learner.entry_count}`,
    `  eligibility    : ${eligibility}`,
    `  learner        : public/content/releases/${built.releaseId}/learner.json`,
    `  server dir     : content-server/releases/${built.releaseId}/`,
    `  sha256 learner : ${built.checksums.learner}`,
    `  sha256 valid.  : ${built.checksums.validation}`,
    `  sha256 assess. : ${built.checksums.assessment}`,
    `  excluded       : ${built.excludedGeneratedFormValues} generated form values, ${built.excludedMazidCandidates} mazid candidates`,
    `  pointer        : public${ACTIVE_POINTER_URL}`,
    `  registry       : content-server/release-registry.json (operational, mutable)`,
  ].join("\n");
  console.log(summary);
  return built;
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    runContentBuild();
  } catch (error) {
    console.error(
      error instanceof ContentBuildError
        ? `content build FAILED: ${error.message}`
        : error,
    );
    process.exit(1);
  }
}
