import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  mkdtempSync,
  readFileSync as readFs,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { sha256HexUtf8 } from "@/modules/content/checksum";
import {
  deriveReleaseIdFromBasis,
  writeImmutableFile,
} from "@/modules/content/build";
import {
  EXPECTED_BAB_COUNTS,
  EXPECTED_ELIGIBILITY_COUNTS,
  UNRESOLVED_ROOT_ENTRY_IDS,
} from "@/modules/content/constants";
import {
  buildArtifacts,
  ContentBuildError,
  PUBLIC_CONTENT_DIR,
  SERVER_CONTENT_DIR,
  SOURCE_DATASET_PATH,
} from "@/modules/content/build";
import {
  activePointerSchema,
  checksumManifestSchema,
  learnerReleaseSchema,
} from "@/modules/content/schema";

const sourceText = readFileSync(SOURCE_DATASET_PATH, "utf8");
const built = buildArtifacts(sourceText);

const LEARNER_ENTRY_KEYS = [
  "id",
  "madi",
  "mudari",
  "masdar",
  "meaning",
  "ism_fail",
  "amr",
  "nahi",
  "bab",
  "bab_arabic",
  "verb_type",
  "verb_type_arabic",
  "book_page",
  "root",
  "transcription_note",
  "quiz_eligibility",
];

describe("content build — learner release", () => {
  it("emits exactly 455 learner entries", () => {
    expect(built.learner.entry_count).toBe(455);
    expect(built.learner.entries).toHaveLength(455);
  });

  it("eligibility counts match the approved matrix", () => {
    for (const [field, expected] of Object.entries(
      EXPECTED_ELIGIBILITY_COUNTS,
    )) {
      const count = built.learner.entries.filter(
        (entry) =>
          entry.quiz_eligibility[
            field as keyof typeof EXPECTED_ELIGIBILITY_COUNTS
          ],
      ).length;
      expect(count, `eligibility for ${field}`).toBe(expected);
    }
  });

  it("learner entries contain only allowlisted fields", () => {
    for (const entry of built.learner.entries) {
      for (const key of Object.keys(entry)) {
        expect(LEARNER_ENTRY_KEYS, `unexpected field ${key}`).toContain(key);
      }
    }
  });

  it("internal metadata, generated forms and mazid are absent", () => {
    const text = built.serialized.learner;
    for (const forbidden of [
      "root_provenance",
      "additional_forms",
      "ism_maful",
      "madi_passive",
      "mudari_passive",
      "transitivity",
      "data_quality",
      "needs_review",
      "blocked_by",
      "mazid",
      "root_compact",
      "root_letters",
      "generated_additional_forms",
    ]) {
      expect(text, `learner release leaks "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  it("unresolved-root entries (369, 372) omit the root value and stay ineligible", () => {
    for (const id of UNRESOLVED_ROOT_ENTRY_IDS) {
      const entry = built.learner.entries.find((e) => e.id === id)!;
      expect(entry.root).toBeUndefined();
      expect(entry.quiz_eligibility.root).toBe(false);
      expect(entry.quiz_eligibility.verb_type).toBe(false);
    }
  });

  it("eligible fields always carry a value; missing value never eligible", () => {
    for (const entry of built.learner.entries) {
      if (entry.quiz_eligibility.root) {
        expect(entry.root, `entry ${entry.id} root`).toBeTruthy();
      } else {
        expect(entry.root).toBeUndefined();
      }
    }
  });

  it("duplicate-madi groups stay separate with distinct mudari", () => {
    const groups: Record<string, number[]> = {};
    for (const entry of built.learner.entries) {
      (groups[entry.madi] ??= []).push(entry.id);
    }
    const duplicates = Object.values(groups)
      .filter((ids) => ids.length > 1)
      .map((ids) => ids.sort((a, b) => a - b));
    expect(duplicates.sort((a, b) => a[0] - b[0])).toEqual([
      [262, 275],
      [297, 303],
      [409, 413],
    ]);
    for (const ids of duplicates) {
      const mudari = new Set(
        ids.map((id) => built.learner.entries.find((e) => e.id === id)!.mudari),
      );
      expect(mudari.size).toBe(ids.length);
    }
  });

  it("bab distribution matches the source book", () => {
    for (const [bab, expected] of Object.entries(EXPECTED_BAB_COUNTS)) {
      const count = built.learner.entries.filter((e) => e.bab === bab).length;
      expect(count, `bab ${bab}`).toBe(expected);
    }
  });

  it("rejects unknown extra fields in public artifacts", () => {
    const withExtra = {
      ...built.learner,
      internal_note: "leaked",
    };
    expect(() => learnerReleaseSchema.parse(withExtra)).toThrow();
  });
});

describe("content build — server manifests", () => {
  it("validation manifest covers every entry with eligibility metadata", () => {
    expect(built.validation.entries).toHaveLength(455);
    const e369 = built.validation.entries.find((e) => e.entry_id === 369)!;
    expect(e369.root_quiz_eligible).toBe(false);
    expect(e369.verb_type_quiz_eligible).toBe(false);
    expect(e369.verb_type_id).toBeNull();
    const e1 = built.validation.entries.find((e) => e.entry_id === 1)!;
    expect(e1.eligible_fields).toContain("madi");
    expect(e1.eligible_fields).toContain("meaning");
    expect(e1.verb_type_id).toBe("sahih");
  });

  it("assessment manifest includes only eligible canonical answers", () => {
    for (const manifestEntry of built.assessment.entries) {
      const learnerEntry = built.learner.entries.find(
        (e) => e.id === manifestEntry.entry_id,
      )!;
      for (const [field, value] of Object.entries(manifestEntry.answers)) {
        if (field === "root") {
          expect(learnerEntry.quiz_eligibility.root).toBe(true);
          expect(value).toBe(learnerEntry.root);
        } else if (field === "bab") {
          expect(learnerEntry.quiz_eligibility.bab).toBe(true);
          expect(value).toBe(learnerEntry.bab);
        } else if (field === "verb_type") {
          expect(learnerEntry.quiz_eligibility.verb_type).toBe(true);
          expect(value).toBe(learnerEntry.verb_type);
        } else {
          const key = field as
            | "madi"
            | "mudari"
            | "masdar"
            | "ism_fail"
            | "amr"
            | "nahi"
            | "meaning";
          expect(learnerEntry.quiz_eligibility[key]).toBe(true);
          expect(value).toBe(learnerEntry[key]);
        }
      }
    }
  });

  it("entries 369 and 372 expose no root/verb_type canonical answers", () => {
    for (const id of UNRESOLVED_ROOT_ENTRY_IDS) {
      const entry = built.assessment.entries.find((e) => e.entry_id === id)!;
      expect(entry.answers.root).toBeUndefined();
      expect(entry.answers.verb_type).toBeUndefined();
    }
  });

  it("ineligible fields are absent from canonical answer maps", () => {
    const e30 = built.assessment.entries.find((e) => e.entry_id === 30)!;
    expect(e30.answers.masdar).toBeUndefined(); // masdar note disables it
    expect(e30.answers.madi).toBeDefined();
  });
});

describe("content build — determinism and identity", () => {
  it("two builds from identical input are byte-identical", () => {
    const second = buildArtifacts(sourceText);
    expect(second.releaseId).toBe(built.releaseId);
    expect(second.serialized).toEqual(built.serialized);
  });

  it("a generated_at-only source change leaves id and all immutable bytes identical", () => {
    const mutated = JSON.parse(sourceText) as { generated_at: string };
    mutated.generated_at = "2031-01-01T00:00:00+00:00";
    const rebuilt = buildArtifacts(JSON.stringify(mutated));
    expect(rebuilt.releaseId).toBe(built.releaseId);
    expect(rebuilt.serialized.learner).toBe(built.serialized.learner);
    expect(rebuilt.serialized.validation).toBe(built.serialized.validation);
    expect(rebuilt.serialized.assessment).toBe(built.serialized.assessment);
    expect(rebuilt.serialized.checksums).toBe(built.serialized.checksums);
    expect(rebuilt.serialized.activePointer).toBe(
      built.serialized.activePointer,
    );
  });

  it("no immutable artifact contains a timestamp", () => {
    for (const text of [
      built.serialized.learner,
      built.serialized.validation,
      built.serialized.assessment,
      built.serialized.checksums,
    ]) {
      expect(text).not.toContain("created_at");
      expect(text).not.toContain("generated_at");
    }
  });

  it("lifecycle/protocol policy is absent from the immutable validation manifest", () => {
    expect(built.serialized.validation).not.toContain("release_status");
    expect(built.serialized.validation).not.toContain(
      "minimum_supported_client_version",
    );
    expect(built.serialized.validation).not.toContain(
      "minimum_supported_event_schema",
    );
  });

  it("release id changes for validation/skill-metadata and assessment changes", () => {
    const basis = {
      schema_version: "2.2.0",
      content_version: "2.2.0",
      question_generator_version: "1",
      learner: { entries: [{ id: 1 }] },
      validation: {
        skill_metadata: [{ id: "meaning_recognition" }],
        entries: [{ entry_id: 1, root_quiz_eligible: true }],
      },
      assessment: { entries: [{ entry_id: 1, answers: { madi: "x" } }] },
    };
    const baseline = deriveReleaseIdFromBasis("2.2.0", basis);
    expect(baseline).toMatch(/^safwa-2\.2\.0-[0-9a-f]{16}$/);

    const skillChanged = structuredClone(basis);
    skillChanged.validation.skill_metadata = [{ id: "typed_meaning_recall" }];
    expect(deriveReleaseIdFromBasis("2.2.0", skillChanged)).not.toBe(baseline);

    const validationChanged = structuredClone(basis);
    validationChanged.validation.entries[0].root_quiz_eligible = false;
    expect(deriveReleaseIdFromBasis("2.2.0", validationChanged)).not.toBe(
      baseline,
    );

    const assessmentChanged = structuredClone(basis);
    assessmentChanged.assessment.entries[0].answers.madi = "y";
    expect(deriveReleaseIdFromBasis("2.2.0", assessmentChanged)).not.toBe(
      baseline,
    );

    // Identical basis => identical id (deterministic).
    expect(deriveReleaseIdFromBasis("2.2.0", structuredClone(basis))).toBe(
      baseline,
    );
  });

  it("a learner-relevant mutation changes the release id and checksum", () => {
    const mutated = JSON.parse(sourceText) as {
      mujarrad_entries: Array<{ meaning: string }>;
    };
    mutated.mujarrad_entries[0].meaning = "to spend (mutated fixture)";
    const rebuilt = buildArtifacts(JSON.stringify(mutated));
    expect(rebuilt.releaseId).not.toBe(built.releaseId);
    expect(rebuilt.checksums.learner).not.toBe(built.checksums.learner);
  });

  it("an internal-only metadata change does not affect public output", () => {
    const mutated = JSON.parse(sourceText) as {
      mujarrad_entries: Array<{
        root_provenance: { method: string };
      }>;
    };
    mutated.mujarrad_entries[0].root_provenance.method = "internal note edit";
    const rebuilt = buildArtifacts(JSON.stringify(mutated));
    expect(rebuilt.releaseId).toBe(built.releaseId);
    expect(rebuilt.serialized.learner).toBe(built.serialized.learner);
    expect(rebuilt.serialized.assessment).toBe(built.serialized.assessment);
  });

  it("a generated form marked quiz-eligible fails the build", () => {
    const mutated = JSON.parse(sourceText) as {
      mujarrad_entries: Array<{
        additional_forms: { ism_maful: { quiz_eligible: boolean } };
      }>;
    };
    mutated.mujarrad_entries[0].additional_forms.ism_maful.quiz_eligible = true;
    expect(() => buildArtifacts(JSON.stringify(mutated))).toThrow(
      ContentBuildError,
    );
  });
});

describe("immutable release writes", () => {
  it("no-op on identical bytes, hard failure on different bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "safwa-immutable-"));
    const target = join(dir, "releases", "safwa-test", "learner.json");
    try {
      expect(writeImmutableFile(target, '{"a":1}\n')).toBe("written");
      expect(readFs(target, "utf8")).toBe('{"a":1}\n');
      // Identical bytes: idempotent no-op.
      expect(writeImmutableFile(target, '{"a":1}\n')).toBe("unchanged");
      // Different bytes beneath an existing release path: hard failure.
      expect(() => writeImmutableFile(target, '{"a":2}\n')).toThrow(
        ContentBuildError,
      );
      // The original bytes were never overwritten.
      expect(readFs(target, "utf8")).toBe('{"a":1}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pre-existing different bytes fail even when written externally", () => {
    const dir = mkdtempSync(join(tmpdir(), "safwa-immutable-"));
    const target = join(dir, "existing.json");
    try {
      writeFileSync(target, "external bytes", "utf8");
      expect(() => writeImmutableFile(target, "build bytes")).toThrow(
        /different bytes/,
      );
      expect(readFs(target, "utf8")).toBe("external bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release registry (operational state)", () => {
  it("exists, is valid, points at the built release, and is outside the immutable dir", () => {
    const registryPath = join(SERVER_CONTENT_DIR, "release-registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      active_release_id: string;
      releases: Record<string, { status: string }>;
    };
    expect(registry.active_release_id).toBe(built.releaseId);
    expect(registry.releases[built.releaseId].status).toBe("active");
    // Lifecycle state lives here, not in any checksummed immutable artifact.
    expect(built.serialized.checksums).not.toContain("release-registry");
  });
});

describe("generated artifacts on disk", () => {
  const releaseDir = join(SERVER_CONTENT_DIR, "releases", built.releaseId);

  it("recorded checksums match independently recomputed hashes", () => {
    const checksums = checksumManifestSchema.parse(
      JSON.parse(readFileSync(join(releaseDir, "checksums.json"), "utf8")),
    );
    const learnerOnDisk = readFileSync(
      join(PUBLIC_CONTENT_DIR, "releases", built.releaseId, "learner.json"),
      "utf8",
    );
    expect(sha256HexUtf8(learnerOnDisk)).toBe(checksums.learner);
    expect(
      sha256HexUtf8(readFileSync(join(releaseDir, "validation.json"), "utf8")),
    ).toBe(checksums.validation);
    expect(
      sha256HexUtf8(readFileSync(join(releaseDir, "assessment.json"), "utf8")),
    ).toBe(checksums.assessment);
  });

  it("active pointer matches the generated release", () => {
    const pointer = activePointerSchema.parse(
      JSON.parse(readFileSync(join(PUBLIC_CONTENT_DIR, "active.json"), "utf8")),
    );
    expect(pointer.release_id).toBe(built.releaseId);
    expect(pointer.learner_sha256).toBe(built.checksums.learner);
    expect(pointer.entry_count).toBe(455);
  });

  it("no assessment or validation artifact exists under public/", () => {
    expect(
      existsSync(
        join(
          PUBLIC_CONTENT_DIR,
          "releases",
          built.releaseId,
          "assessment.json",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          PUBLIC_CONTENT_DIR,
          "releases",
          built.releaseId,
          "validation.json",
        ),
      ),
    ).toBe(false);
    expect(existsSync(join(PUBLIC_CONTENT_DIR, "assessment.json"))).toBe(false);
  });
});
