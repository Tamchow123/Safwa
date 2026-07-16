/**
 * Content-pipeline constants shared by the build (Node) and the client.
 * Browser-safe: no Node imports.
 */

/**
 * Version of the (future) deterministic question generator. Recorded in
 * every release artifact now so attempts can be validated by regeneration
 * later (ADR-006). Format: plain integer string, incremented on any change
 * to generator behaviour.
 */
export const QUESTION_GENERATOR_VERSION = "1";

/** Source fields a translation study component can be built on. */
export const SOURCE_QUIZ_FORM_FIELDS = [
  "madi",
  "mudari",
  "masdar",
  "ism_fail",
  "amr",
  "nahi",
] as const;
export type SourceQuizFormField = (typeof SOURCE_QUIZ_FORM_FIELDS)[number];

/** All objective answer fields (form fields + meaning + entry-level facts). */
export const ANSWER_FIELDS = [
  "madi",
  "mudari",
  "masdar",
  "ism_fail",
  "amr",
  "nahi",
  "meaning",
  "root",
  "bab",
  "verb_type",
] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];

export const DIRECTIONS = ["arabic_to_english", "english_to_arabic"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const COMPONENT_SHAPES = ["form_direction", "entry_level"] as const;
export type ComponentShape = (typeof COMPONENT_SHAPES)[number];

export const SKILL_TYPES = [
  "meaning_recognition",
  "meaning_recall",
  "bab_identification",
  "root_identification",
  "verb_type_identification",
] as const;
export type SkillType = (typeof SKILL_TYPES)[number];

export type SkillMetadata = {
  id: SkillType;
  component_shape: ComponentShape;
  allowed_source_fields: readonly SourceQuizFormField[];
  allowed_directions: readonly Direction[];
};

/** Initial skill metadata per the approved architecture (ADR-004). */
export const SKILL_METADATA: readonly SkillMetadata[] = [
  {
    id: "meaning_recognition",
    component_shape: "form_direction",
    allowed_source_fields: SOURCE_QUIZ_FORM_FIELDS,
    allowed_directions: ["arabic_to_english"],
  },
  {
    id: "meaning_recall",
    component_shape: "form_direction",
    allowed_source_fields: SOURCE_QUIZ_FORM_FIELDS,
    allowed_directions: ["english_to_arabic"],
  },
  {
    id: "bab_identification",
    component_shape: "entry_level",
    allowed_source_fields: [],
    allowed_directions: [],
  },
  {
    id: "root_identification",
    component_shape: "entry_level",
    allowed_source_fields: [],
    allowed_directions: [],
  },
  {
    id: "verb_type_identification",
    component_shape: "entry_level",
    allowed_source_fields: [],
    allowed_directions: [],
  },
];

export const BAB_IDS = [
  "nasara",
  "daraba",
  "samia",
  "fataha",
  "karuma",
  "hasiba",
] as const;
export type BabId = (typeof BAB_IDS)[number];

export const VERB_TYPE_IDS = [
  "sahih",
  "mudaaf",
  "mahmuz_fa",
  "mahmuz_ain",
  "mahmuz_lam",
  "mithal_wawi",
  "mithal_yai",
  "ajwaf_wawi",
  "ajwaf_yai",
  "naqis_wawi",
  "naqis_yai",
  "lafif_mafruq",
  "lafif_maqrun",
] as const;
export type VerbTypeId = (typeof VERB_TYPE_IDS)[number];

/** Expected release invariants (from docs/vocabulary-audit.md, verified). */
export const EXPECTED_ENTRY_COUNT = 455;

export const EXPECTED_ELIGIBILITY_COUNTS = {
  madi: 455,
  mudari: 454,
  masdar: 445,
  meaning: 455,
  ism_fail: 454,
  amr: 454,
  nahi: 454,
  bab: 455,
  verb_type: 453,
  root: 453,
} as const;

export const EXPECTED_BAB_COUNTS: Record<BabId, number> = {
  nasara: 140,
  daraba: 127,
  fataha: 74,
  samia: 73,
  karuma: 35,
  hasiba: 6,
};

export const UNRESOLVED_ROOT_ENTRY_IDS = [369, 372] as const;

export const EXPECTED_DUPLICATE_MADI_GROUPS: readonly (readonly number[])[] = [
  [262, 275],
  [297, 303],
  [409, 413],
];

export const RELEASE_ID_PREFIX = "safwa";
/** Hex chars of the release-basis SHA-256 used in the release id. */
export const RELEASE_ID_HASH_LENGTH = 16;

/** Public URL (Next.js public dir) of a release's learner artifact. */
export function learnerUrlForRelease(releaseId: string): string {
  return `/content/releases/${releaseId}/learner.json`;
}

export const ACTIVE_POINTER_URL = "/content/active.json";

export const MINIMUM_SUPPORTED_CLIENT_VERSION = "0.1.0";
export const MINIMUM_SUPPORTED_EVENT_SCHEMA = 1;
