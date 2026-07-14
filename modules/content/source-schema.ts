/**
 * Zod schema for the enriched source dataset `data/safwa-vocabulary.v2.json`.
 *
 * Actual source structure (inspected 2026-07-14, schema_version 2.2.0):
 * - top level: schema_version, generated_at, source, statistics,
 *   mujarrad_entries[455], mazid_fih_patterns, mazid_fih_entries[21]
 * - entry: 13 source-transcribed fields (id, madi, mudari, masdar, meaning,
 *   ism_fail, amr, nahi, bab, bab_arabic, verb_type, verb_type_arabic,
 *   book_page [+ optional transcription_note on 14 entries]), enriched
 *   fields (root/root_compact/root_letters, form_number, form_type,
 *   root_provenance, transitivity), generated additional_forms
 *   (ism_maful/madi_passive/mudari_passive cells with status +
 *   quiz_eligible), field-level quiz_eligibility (11 booleans incl.
 *   generated_additional_forms), data_quality.
 *
 * The dataset has no separate content version; `schema_version` is used as
 * the content version for release identity (plus a content hash).
 *
 * These schemas are deliberately LOOSE (unknown keys allowed) because the
 * source is authored by the Python pipeline and may gain internal fields;
 * the learner output is built from an explicit allowlist, never by
 * spreading source objects.
 */
import { z } from "zod";

import { BAB_IDS, VERB_TYPE_IDS } from "@/modules/content/constants";

const additionalFormCellSchema = z.looseObject({
  value: z.string().nullable(),
  status: z.string(),
  quiz_eligible: z.boolean(),
  blocked_by: z.string().nullable(),
  verification_source: z.string().nullable(),
});

export const sourceQuizEligibilitySchema = z.looseObject({
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
  generated_additional_forms: z.boolean(),
});

export const sourceEntrySchema = z.looseObject({
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
  transcription_note: z.string().optional(),
  root: z.string().min(1),
  quiz_eligibility: sourceQuizEligibilitySchema,
  additional_forms: z.looseObject({
    ism_maful: additionalFormCellSchema,
    madi_passive: additionalFormCellSchema,
    mudari_passive: additionalFormCellSchema,
  }),
  data_quality: z.looseObject({
    root_status: z.string(),
    requires_manual_review: z.boolean(),
  }),
});

const statisticsSchema = z.looseObject({
  mujarrad_entry_count: z.number().int(),
  entries_per_bab: z.record(z.string(), z.number().int()),
  quiz_eligibility_statistics: z.record(z.string(), z.number().int()),
  generated_additional_form_values: z.number().int(),
  mazid_fih_candidate_count: z.number().int(),
});

export const sourceDatasetSchema = z.looseObject({
  schema_version: z.string().min(1),
  generated_at: z.string().min(1),
  source: z.looseObject({
    title: z.string(),
    entry_count: z.number().int(),
  }),
  statistics: statisticsSchema,
  mujarrad_entries: z.array(sourceEntrySchema),
  mazid_fih_patterns: z.unknown(),
  mazid_fih_entries: z.array(
    z.looseObject({
      id: z.string(),
      quiz_eligible: z.boolean(),
    }),
  ),
});

export type SourceDataset = z.infer<typeof sourceDatasetSchema>;
export type SourceEntry = z.infer<typeof sourceEntrySchema>;
