import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256HexUtf8 } from "@/modules/content/checksum";

/**
 * Builds a minimal, schema-valid three-artifact release fixture on disk
 * for tests/content/server-manifests.test.ts. Returns the two root
 * directories (`contentServerDir`, `publicContentDir`) to pass as
 * `loadAndVerifyRelease`/`getActiveRelease` options, plus a `corrupt()`
 * helper for rewriting one artifact file with deliberately-wrong bytes and
 * a `cleanup()` to remove the whole fixture directory.
 */

export const FIXTURE_RELEASE_ID = "test-release-0001";

type FixtureOverrides = {
  releaseId?: string;
  contentVersion?: string;
  schemaVersion?: string;
  questionGeneratorVersion?: string;
  entryCount?: number;
};

function learnerJson(o: Required<FixtureOverrides>): string {
  return JSON.stringify(
    {
      release_id: o.releaseId,
      schema_version: o.schemaVersion,
      content_version: o.contentVersion,
      question_generator_version: o.questionGeneratorVersion,
      entry_count: o.entryCount,
      entries: [
        {
          id: 1,
          madi: "m1",
          mudari: "m2",
          masdar: "m3",
          meaning: "to test",
          ism_fail: "m4",
          amr: "m5",
          nahi: "m6",
          bab: "nasara",
          bab_arabic: "b1",
          verb_type: "sahih",
          verb_type_arabic: "v1",
          book_page: 1,
          quiz_eligibility: {
            madi: true,
            mudari: true,
            masdar: true,
            meaning: true,
            ism_fail: true,
            amr: true,
            nahi: true,
            bab: true,
            verb_type: true,
            root: false,
          },
        },
      ],
    },
    null,
    2,
  );
}

function validationJson(o: Required<FixtureOverrides>): string {
  return JSON.stringify(
    {
      release_id: o.releaseId,
      schema_version: o.schemaVersion,
      content_version: o.contentVersion,
      question_generator_version: o.questionGeneratorVersion,
      entry_count: o.entryCount,
      allowed_source_fields: [
        "madi",
        "mudari",
        "masdar",
        "ism_fail",
        "amr",
        "nahi",
      ],
      allowed_directions: ["arabic_to_english", "english_to_arabic"],
      allowed_skill_types: [
        "meaning_recognition",
        "meaning_recall",
        "bab_identification",
        "root_identification",
        "verb_type_identification",
      ],
      valid_component_shapes: ["form_direction", "entry_level"],
      skill_metadata: [
        {
          id: "meaning_recognition",
          component_shape: "form_direction",
          allowed_source_fields: [
            "madi",
            "mudari",
            "masdar",
            "ism_fail",
            "amr",
            "nahi",
          ],
          allowed_directions: ["arabic_to_english"],
        },
      ],
      entries: [
        {
          entry_id: 1,
          eligible_fields: ["madi", "mudari", "masdar", "meaning"],
          bab_id: "nasara",
          verb_type_id: "sahih",
          root_quiz_eligible: false,
          bab_quiz_eligible: true,
          verb_type_quiz_eligible: true,
        },
      ],
    },
    null,
    2,
  );
}

function assessmentJson(o: Required<FixtureOverrides>): string {
  return JSON.stringify(
    {
      release_id: o.releaseId,
      schema_version: o.schemaVersion,
      content_version: o.contentVersion,
      question_generator_version: o.questionGeneratorVersion,
      entry_count: o.entryCount,
      entries: [
        {
          entry_id: 1,
          answers: { madi: "m1", meaning: "to test" },
        },
      ],
    },
    null,
    2,
  );
}

export type ManifestFixture = {
  contentServerDir: string;
  publicContentDir: string;
  releaseId: string;
  /** Overwrite one artifact file with arbitrary bytes (or a JSON value). */
  corrupt: (
    artifact: "learner" | "validation" | "assessment" | "checksums",
    contentOrRaw: unknown,
  ) => Promise<void>;
  cleanup: () => Promise<void>;
};

/** Writes one release's three artifacts + checksums.json into existing roots. */
async function writeReleaseArtifacts(
  contentServerDir: string,
  publicContentDir: string,
  overrides: FixtureOverrides,
): Promise<{ releaseId: string }> {
  const o: Required<FixtureOverrides> = {
    releaseId: overrides.releaseId ?? FIXTURE_RELEASE_ID,
    contentVersion: overrides.contentVersion ?? "1.0.0",
    schemaVersion: overrides.schemaVersion ?? "1.0.0",
    questionGeneratorVersion: overrides.questionGeneratorVersion ?? "1",
    entryCount: overrides.entryCount ?? 1,
  };

  const serverReleaseDir = join(contentServerDir, "releases", o.releaseId);
  const publicReleaseDir = join(publicContentDir, "releases", o.releaseId);
  await mkdir(serverReleaseDir, { recursive: true });
  await mkdir(publicReleaseDir, { recursive: true });

  const learner = learnerJson(o);
  const validation = validationJson(o);
  const assessment = assessmentJson(o);
  const checksums = JSON.stringify(
    {
      algorithm: "sha256",
      release_id: o.releaseId,
      learner: sha256HexUtf8(learner),
      validation: sha256HexUtf8(validation),
      assessment: sha256HexUtf8(assessment),
    },
    null,
    2,
  );

  await writeFile(join(publicReleaseDir, "learner.json"), learner, "utf8");
  await writeFile(
    join(serverReleaseDir, "validation.json"),
    validation,
    "utf8",
  );
  await writeFile(
    join(serverReleaseDir, "assessment.json"),
    assessment,
    "utf8",
  );
  await writeFile(join(serverReleaseDir, "checksums.json"), checksums, "utf8");

  return { releaseId: o.releaseId };
}

export async function buildManifestFixture(
  overrides: FixtureOverrides = {},
): Promise<ManifestFixture> {
  const root = await mkdtemp(join(tmpdir(), "safwa-manifest-fixture-"));
  const contentServerDir = join(root, "content-server");
  const publicContentDir = join(root, "public-content");
  const { releaseId } = await writeReleaseArtifacts(
    contentServerDir,
    publicContentDir,
    overrides,
  );

  const fileFor = (
    artifact: "learner" | "validation" | "assessment" | "checksums",
    forReleaseId: string,
  ) =>
    artifact === "learner"
      ? join(publicContentDir, "releases", forReleaseId, "learner.json")
      : join(contentServerDir, "releases", forReleaseId, `${artifact}.json`);

  return {
    contentServerDir,
    publicContentDir,
    releaseId,
    async corrupt(artifact, contentOrRaw) {
      const raw =
        typeof contentOrRaw === "string"
          ? contentOrRaw
          : JSON.stringify(contentOrRaw, null, 2);
      await writeFile(fileFor(artifact, releaseId), raw, "utf8");
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Adds a second (or subsequent) release's artifacts into an existing
 * fixture's `contentServerDir`/`publicContentDir` roots — for tests that
 * need more than one release under one registry (e.g. proving an
 * active-release swap between two releases never transiently violates the
 * `content_versions` single-active constraint).
 */
export async function addReleaseToFixture(
  fixture: ManifestFixture,
  overrides: FixtureOverrides,
): Promise<{ releaseId: string }> {
  return writeReleaseArtifacts(
    fixture.contentServerDir,
    fixture.publicContentDir,
    overrides,
  );
}

/** Writes a release-registry.json into `contentServerDir`. */
export async function writeRegistry(
  contentServerDir: string,
  registry: unknown,
): Promise<void> {
  await writeFile(
    join(contentServerDir, "release-registry.json"),
    JSON.stringify(registry, null, 2),
    "utf8",
  );
}
