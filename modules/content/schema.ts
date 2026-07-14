/**
 * Strict Zod schemas for every generated content artifact and for the
 * client cache records. Generated artifacts reject unknown fields so the
 * public surface can never silently grow. Browser-safe.
 */
import { z } from "zod";

import {
  ANSWER_FIELDS,
  BAB_IDS,
  COMPONENT_SHAPES,
  DIRECTIONS,
  SKILL_TYPES,
  SOURCE_QUIZ_FORM_FIELDS,
  VERB_TYPE_IDS,
} from "@/modules/content/constants";

/** Field-level quiz eligibility exposed to learners (10 booleans). */
export const learnerQuizEligibilitySchema = z.strictObject({
  madi: z.boolean(),
  mudari: z.boolean(),
  masdar: z.boolean(),
  meaning: z.boolean(),
  ism_fail: z.boolean(),
  amr: z.boolean(),
  nahi: z.boolean(),
  bab: z.boolean(),
  verb_type: z.boolean(),
  root: z.boolean(),
});

export const learnerEntrySchema = z.strictObject({
  id: z.number().int().min(1),
  madi: z.string().min(1),
  mudari: z.string().min(1),
  masdar: z.string().min(1),
  meaning: z.string().min(1),
  ism_fail: z.string().min(1),
  amr: z.string().min(1),
  nahi: z.string().min(1),
  bab: z.enum(BAB_IDS),
  bab_arabic: z.string().min(1),
  verb_type: z.enum(VERB_TYPE_IDS),
  verb_type_arabic: z.string().min(1),
  book_page: z.number().int(),
  /** Present only when the root is internally validated (quiz-eligible). */
  root: z.string().min(1).optional(),
  /** Learner-safe printed-source note (source transparency), when present. */
  transcription_note: z.string().min(1).optional(),
  quiz_eligibility: learnerQuizEligibilitySchema,
});
export type LearnerEntry = z.infer<typeof learnerEntrySchema>;

export const learnerReleaseSchema = z.strictObject({
  release_id: z.string().min(1),
  schema_version: z.string().min(1),
  content_version: z.string().min(1),
  created_at: z.string().min(1),
  question_generator_version: z.string().min(1),
  entry_count: z.number().int().positive(),
  entries: z.array(learnerEntrySchema),
});
export type LearnerRelease = z.infer<typeof learnerReleaseSchema>;

export const activePointerSchema = z.strictObject({
  release_id: z.string().min(1),
  content_version: z.string().min(1),
  schema_version: z.string().min(1),
  question_generator_version: z.string().min(1),
  learner_url: z.string().startsWith("/content/"),
  learner_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entry_count: z.number().int().positive(),
});
export type ActivePointer = z.infer<typeof activePointerSchema>;

export const skillMetadataSchema = z.strictObject({
  id: z.enum(SKILL_TYPES),
  component_shape: z.enum(COMPONENT_SHAPES),
  allowed_source_fields: z.array(z.enum(SOURCE_QUIZ_FORM_FIELDS)),
  allowed_directions: z.array(z.enum(DIRECTIONS)),
});

export const validationManifestEntrySchema = z.strictObject({
  entry_id: z.number().int().min(1),
  /** Source fields eligible as component/prompt material (incl. meaning). */
  eligible_fields: z.array(z.enum([...SOURCE_QUIZ_FORM_FIELDS, "meaning"])),
  bab_id: z.enum(BAB_IDS),
  /** Null while the verb-type classification is under review (369, 372). */
  verb_type_id: z.enum(VERB_TYPE_IDS).nullable(),
  root_quiz_eligible: z.boolean(),
  bab_quiz_eligible: z.boolean(),
  verb_type_quiz_eligible: z.boolean(),
});

export const validationManifestSchema = z.strictObject({
  release_id: z.string().min(1),
  schema_version: z.string().min(1),
  content_version: z.string().min(1),
  created_at: z.string().min(1),
  question_generator_version: z.string().min(1),
  release_status: z.enum(["active", "supported", "revoked"]),
  minimum_supported_client_version: z.string().min(1),
  minimum_supported_event_schema: z.number().int().positive(),
  entry_count: z.number().int().positive(),
  allowed_source_fields: z.array(z.enum(SOURCE_QUIZ_FORM_FIELDS)),
  allowed_directions: z.array(z.enum(DIRECTIONS)),
  allowed_skill_types: z.array(z.enum(SKILL_TYPES)),
  valid_component_shapes: z.array(z.enum(COMPONENT_SHAPES)),
  skill_metadata: z.array(skillMetadataSchema),
  entries: z.array(validationManifestEntrySchema),
});
export type ValidationManifest = z.infer<typeof validationManifestSchema>;

export const assessmentManifestEntrySchema = z.strictObject({
  entry_id: z.number().int().min(1),
  /** Canonical answers for quiz-eligible fields only. */
  answers: z.partialRecord(z.enum(ANSWER_FIELDS), z.string().min(1)),
});

export const assessmentManifestSchema = z.strictObject({
  release_id: z.string().min(1),
  schema_version: z.string().min(1),
  content_version: z.string().min(1),
  created_at: z.string().min(1),
  question_generator_version: z.string().min(1),
  entry_count: z.number().int().positive(),
  entries: z.array(assessmentManifestEntrySchema),
});
export type AssessmentManifest = z.infer<typeof assessmentManifestSchema>;

export const checksumManifestSchema = z.strictObject({
  algorithm: z.literal("sha256"),
  release_id: z.string().min(1),
  learner: z.string().regex(/^[0-9a-f]{64}$/),
  validation: z.string().regex(/^[0-9a-f]{64}$/),
  assessment: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ChecksumManifest = z.infer<typeof checksumManifestSchema>;

/* ------------------------------------------------------------------ */
/* Client cache records (Dexie)                                        */
/* ------------------------------------------------------------------ */

export const contentReleaseRecordSchema = z.strictObject({
  releaseId: z.string().min(1),
  contentVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  learnerChecksum: z.string().regex(/^[0-9a-f]{64}$/),
  questionGeneratorVersion: z.string().min(1),
  entryCount: z.number().int().positive(),
  cachedAt: z.number(),
});
export type ContentReleaseRecord = z.infer<typeof contentReleaseRecordSchema>;

export type ContentEntryRecord = {
  releaseId: string;
  entryId: number;
  bab: LearnerEntry["bab"];
  verbType: LearnerEntry["verb_type"];
  bookPage: number;
  entry: LearnerEntry;
};

export type ContentMetadataRecord = {
  key: "active";
  activeReleaseId: string;
  activeReleaseChecksum: string;
  lastSuccessfulRefreshAt: number;
};
