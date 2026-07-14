import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256HexUtf8 } from "@/modules/content/checksum";
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
