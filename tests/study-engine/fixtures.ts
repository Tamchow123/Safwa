/**
 * Shared study-engine test fixtures: the REAL learner release built from the
 * immutable dataset, plus a ready QuestionContext. Building once here keeps the
 * heavy property tests fast and guarantees they run against production content
 * (455 entries, real eligibility matrix), not a hand-authored stand-in.
 */
import { readFileSync } from "node:fs";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { LearnerEntry, LearnerRelease } from "@/modules/content/schema";
import { createQuestionContext } from "@/modules/study-engine/generator";

const sourceText = readFileSync(SOURCE_DATASET_PATH, "utf8");

export const learnerRelease: LearnerRelease =
  buildArtifacts(sourceText).learner;

export const learnerEntries: readonly LearnerEntry[] = learnerRelease.entries;

export const entriesById = new Map(
  learnerEntries.map((entry) => [entry.id, entry]),
);

export const questionContext = createQuestionContext(learnerRelease);

export function entry(id: number): LearnerEntry {
  const found = entriesById.get(id);
  if (!found) throw new Error(`test fixture: no entry ${id}`);
  return found;
}
