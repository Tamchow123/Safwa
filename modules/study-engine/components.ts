/**
 * Study-component derivation from the learner-release eligibility matrix.
 *
 * The set of components that EXIST for an entry is derived here — never from
 * database row counts — so progress denominators come from content
 * (DATA_MODEL.md §2). A component is derived only when every field it depends
 * on is quiz-eligible; ineligible fields therefore never yield a component,
 * and consequently can never be selected as a target (CLAUDE.md hard rule 2).
 *
 * Components split into ESSENTIAL vs EXTENDED sets per PRODUCT_REQUIREMENTS.md
 * §5: word (entry) mastery derives from the essential set only; extended
 * components are tracked but never block word mastery.
 *
 * Materialisation is LAZY: derivation lists which components are possible;
 * `materialiseComponent` produces a record on first attempt and refuses to
 * materialise an ineligible component.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import {
  SOURCE_QUIZ_FORM_FIELDS,
  type ComponentShape,
  type Direction,
  type SkillType,
  type SourceQuizFormField,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";

import {
  buildComponentKey,
  resolveComponentIdentity,
  type ComponentIdentity,
} from "@/modules/study-engine/natural-key";

export type DerivedComponent = {
  key: string;
  entryId: number;
  skillType: SkillType;
  componentShape: ComponentShape;
  sourceField: SourceQuizFormField | null;
  direction: Direction | null;
  /** Part of the essential set that determines word mastery (§5). */
  essential: boolean;
};

/**
 * Essential recognition (Ar→En) source fields for word mastery: meaning
 * recognition of each eligible field among {madi, mudari, masdar}
 * (PRODUCT_REQUIREMENTS.md §5).
 */
const ESSENTIAL_RECOGNITION_FIELDS: readonly SourceQuizFormField[] = [
  "madi",
  "mudari",
  "masdar",
];

/** Essential recall (En→Ar) source fields: recall of madi only (§5). */
const ESSENTIAL_RECALL_FIELDS: readonly SourceQuizFormField[] = ["madi"];

/**
 * Is the translation of `field` (both recognition and recall directions)
 * quiz-eligible for this entry? The prompt/answer pair always involves the
 * form field AND the English meaning, so both must be eligible.
 */
function isTranslationFieldEligible(
  entry: LearnerEntry,
  field: SourceQuizFormField,
): boolean {
  return entry.quiz_eligibility[field] && entry.quiz_eligibility.meaning;
}

function derivedFormComponent(
  entry: LearnerEntry,
  skillType: SkillType,
  sourceField: SourceQuizFormField,
  direction: Direction,
  essential: boolean,
): DerivedComponent {
  const identity: ComponentIdentity = {
    entryId: entry.id,
    skillType,
    sourceField,
    direction,
  };
  return {
    key: buildComponentKey(identity),
    entryId: entry.id,
    skillType,
    componentShape: "form_direction",
    sourceField,
    direction,
    essential,
  };
}

function derivedEntryLevelComponent(
  entry: LearnerEntry,
  skillType: SkillType,
  essential: boolean,
): DerivedComponent {
  const identity: ComponentIdentity = { entryId: entry.id, skillType };
  return {
    key: buildComponentKey(identity),
    entryId: entry.id,
    skillType,
    componentShape: "entry_level",
    sourceField: null,
    direction: null,
    essential,
  };
}

/**
 * Derive every study component that exists for one entry, in a stable,
 * deterministic order. Only quiz-eligible fields yield components.
 */
export function deriveComponentsForEntry(
  entry: LearnerEntry,
): DerivedComponent[] {
  const components: DerivedComponent[] = [];

  // Meaning recognition (Ar→En), one component per eligible source field.
  for (const field of SOURCE_QUIZ_FORM_FIELDS) {
    if (!isTranslationFieldEligible(entry, field)) continue;
    components.push(
      derivedFormComponent(
        entry,
        "meaning_recognition",
        field,
        "arabic_to_english",
        ESSENTIAL_RECOGNITION_FIELDS.includes(field),
      ),
    );
  }

  // Meaning recall (En→Ar), one component per eligible source field.
  for (const field of SOURCE_QUIZ_FORM_FIELDS) {
    if (!isTranslationFieldEligible(entry, field)) continue;
    components.push(
      derivedFormComponent(
        entry,
        "meaning_recall",
        field,
        "english_to_arabic",
        ESSENTIAL_RECALL_FIELDS.includes(field),
      ),
    );
  }

  // Entry-level: bab (essential, always eligible), root (essential when
  // eligible), verb_type (extended).
  if (entry.quiz_eligibility.bab) {
    components.push(
      derivedEntryLevelComponent(entry, "bab_identification", true),
    );
  }
  if (entry.quiz_eligibility.root) {
    components.push(
      derivedEntryLevelComponent(entry, "root_identification", true),
    );
  }
  if (entry.quiz_eligibility.verb_type) {
    components.push(
      derivedEntryLevelComponent(entry, "verb_type_identification", false),
    );
  }

  return components;
}

/** Derive components across many entries (source order preserved). */
export function deriveAllComponents(
  entries: readonly LearnerEntry[],
): DerivedComponent[] {
  return entries.flatMap((entry) => deriveComponentsForEntry(entry));
}

/** The essential components of an entry (word-mastery set, §5). */
export function essentialComponentsForEntry(
  entry: LearnerEntry,
): DerivedComponent[] {
  return deriveComponentsForEntry(entry).filter(
    (component) => component.essential,
  );
}

/**
 * Is the given component identity eligible to exist for this entry? This is
 * the authoritative gate for lazy materialisation: an identity whose fields
 * are ineligible (or whose shape is invalid) is not eligible.
 */
export function isComponentEligible(
  entry: LearnerEntry,
  identity: ComponentIdentity,
): boolean {
  let resolved;
  try {
    resolved = resolveComponentIdentity(identity);
  } catch {
    return false;
  }
  if (resolved.entryId !== entry.id) return false;

  switch (resolved.skillType) {
    case "meaning_recognition":
    case "meaning_recall":
      return isTranslationFieldEligible(entry, resolved.sourceField!);
    case "bab_identification":
      return entry.quiz_eligibility.bab;
    case "root_identification":
      return entry.quiz_eligibility.root;
    case "verb_type_identification":
      return entry.quiz_eligibility.verb_type;
  }
}

export type MaterialisedComponent = {
  key: string;
  entryId: number;
  skillType: SkillType;
  componentShape: ComponentShape;
  sourceField: SourceQuizFormField | null;
  direction: Direction | null;
};

export class IneligibleComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IneligibleComponentError";
  }
}

/**
 * Lazily materialise a component on first attempt. Refuses (throws) to
 * materialise an ineligible or shape-invalid component — the single choke
 * point that keeps ineligible fields out of learner state.
 */
export function materialiseComponent(
  entry: LearnerEntry,
  identity: ComponentIdentity,
): MaterialisedComponent {
  const resolved = resolveComponentIdentity(identity);
  if (!isComponentEligible(entry, identity)) {
    throw new IneligibleComponentError(
      `component ${buildComponentKey(identity)} is not quiz-eligible for entry ${entry.id}`,
    );
  }
  return {
    key: buildComponentKey(identity),
    entryId: resolved.entryId,
    skillType: resolved.skillType,
    componentShape: resolved.componentShape,
    sourceField: resolved.sourceField,
    direction: resolved.direction,
  };
}
