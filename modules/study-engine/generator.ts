/**
 * Deterministic question generation for objective quizzes and flashcards.
 *
 * A question is a pure function of its inputs — the caller's `question_seed`,
 * the generator version, the authoritative `release_id` (ADR-003; never
 * `content_version`, which may repeat), component key, and the structural
 * parameters (mode, position, prompt form) — never Date.now / Math.random (a
 * lint rule forbids them). Internally these fold into one per-instance seed, so
 * the same inputs always reproduce one byte-identical question AND two
 * structurally-different questions never share an instance id. A recorded
 * QuestionSpec regenerates the identical question (used optimistically on the
 * client and authoritatively by the server in Phase 16).
 *
 * Eligibility is enforced at the single choke point: a component is only
 * quizzed when eligible, prompts only use eligible forms, and the candidate
 * pool only ever contains eligible answer values (CLAUDE.md hard rule 2).
 * Bāb options render as the Arabic pair from `bab_arabic`, never a number.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import {
  ANSWER_FIELDS,
  QUESTION_GENERATOR_VERSION,
  type AnswerField,
  type ComponentShape,
  type Direction,
  type SkillType,
  type SourceQuizFormField,
} from "@/modules/content/constants";
import {
  serializeAnswerReference,
  type AnswerReference,
} from "@/modules/content/answer-reference";
import type { LearnerEntry, LearnerRelease } from "@/modules/content/schema";

import { isComponentEligible } from "@/modules/study-engine/components";
import {
  answerComparisonKey,
  fieldValue,
  isFieldEligible,
  isSourceFormField,
} from "@/modules/study-engine/fields";
import {
  selectDistractors,
  type DistractorCandidate,
  type DistractorTarget,
} from "@/modules/study-engine/distractors";
import {
  buildComponentKey,
  parseComponentKey,
  resolveComponentIdentity,
  type ComponentIdentity,
  type ResolvedComponentIdentity,
} from "@/modules/study-engine/natural-key";
import {
  canonicalKey,
  createRng,
  stableHash128Hex,
} from "@/modules/study-engine/rng";

export const DEFAULT_OPTION_COUNT = 4;
/** The default prompt form for entry-level (bāb/root/verb-type) questions. */
export const DEFAULT_ENTRY_LEVEL_PROMPT_FORM: SourceQuizFormField = "madi";

/** Question STRUCTURE: MC has options, flashcard does not. */
export type QuestionMode = "mc" | "flashcard";

/**
 * The effective DELIVERY mode — part of the question's identity so a plain-MC,
 * timed, and test question with the same seed/component/position/prompt are
 * distinct instances (they are presented differently even though the structure
 * matches). Structurally, `timed`/`test` are MC.
 */
export type DeliveryMode = "mc" | "flashcard" | "timed" | "test";

/** The question structure implied by a delivery mode. */
export function questionModeForDelivery(delivery: DeliveryMode): QuestionMode {
  return delivery === "flashcard" ? "flashcard" : "mc";
}

export type QuestionOption = {
  ref: AnswerReference;
  /** Display value shown to the learner (Arabic form, meaning or bāb pair). */
  displayValue: string;
  isCorrect: boolean;
};

export const HINT_TYPES = [
  "first_letter",
  "root",
  "word_length",
  "bab",
  "form",
] as const;
export type HintType = (typeof HINT_TYPES)[number];

/**
 * Hint recording substrate. A discriminated union so a contradictory state
 * (used with no type, or a type with used=false) is unrepresentable for typed
 * callers; `assertValidHintState` enforces the same at untyped boundaries.
 */
export type HintState =
  { used: false; type: null } | { used: true; type: HintType };

/**
 * The canonical "no hint used" value. FROZEN so it can never become shared
 * mutable module state — callers that record a hint must build a fresh object,
 * not mutate this. Each generated question gets its OWN fresh hint-state object
 * (see `freshNoHint`), so mutating one question's hint state cannot leak into
 * another's.
 */
export const NO_HINT: HintState = Object.freeze({ used: false, type: null });

/** A fresh, independently-mutable "no hint" object for a new question/attempt. */
export function freshNoHint(): HintState {
  return { used: false, type: null };
}

/**
 * Reject a contradictory hint state at a runtime (untyped) boundary. Accepts a
 * loose shape on purpose — the discriminated union already prevents typed
 * callers from constructing a bad state; this guards data crossing an untyped
 * edge (deserialized specs, JS callers).
 */
export function assertValidHintState(hint: unknown): HintState {
  if (hint === null || typeof hint !== "object") {
    throw new QuestionGenerationError(
      `hint must be an object, got ${hint === null ? "null" : typeof hint}`,
    );
  }
  const { used, type } = hint as { used: unknown; type: unknown };
  if (typeof used !== "boolean") {
    throw new QuestionGenerationError("hint.used must be a boolean");
  }
  if (used) {
    if (
      typeof type !== "string" ||
      !(HINT_TYPES as readonly string[]).includes(type)
    ) {
      throw new QuestionGenerationError(
        `hint marked used but type ${JSON.stringify(type)} is not a known hint type`,
      );
    }
  } else if (type !== null) {
    throw new QuestionGenerationError(
      `hint marked unused but carries type ${JSON.stringify(type)}`,
    );
  }
  return { used, type } as HintState;
}

export type QuestionInstance = {
  questionInstanceId: string;
  questionSeed: string;
  questionGeneratorVersion: string;
  /** Authoritative content identity (ADR-003). */
  releaseId: string;
  contentVersion: string;
  componentKey: string;
  skillType: SkillType;
  componentShape: ComponentShape;
  entryId: number;
  sourceField: SourceQuizFormField | null;
  direction: Direction | null;
  mode: QuestionMode;
  /** Effective delivery mode — part of the instance identity. */
  deliveryMode: DeliveryMode;
  /** The field shown as the prompt (its type is revealed only after answering). */
  promptField: AnswerField;
  promptRef: AnswerReference;
  answerField: AnswerField;
  /** Four options for MC; empty for flashcards. */
  options: QuestionOption[];
  allowedAnswerRefs: AnswerReference[];
  correctAnswerRef: AnswerReference;
  position: number;
  hintState: HintState;
};

/**
 * The serialisable question-instance specification (phase scope; ADR-006).
 * Carries both the regeneration inputs AND the derived fields the server
 * checks on reconstruction — `question_instance_id`, `allowed_answer_refs`,
 * `correct_answer_ref` and hint state — so a recorded spec both reproduces the
 * question and lets the server detect any tampering with those fields.
 */
export type QuestionSpec = {
  questionInstanceId: string;
  questionSeed: string;
  questionGeneratorVersion: string;
  releaseId: string;
  contentVersion: string;
  componentKey: string;
  deliveryMode: DeliveryMode;
  promptField: AnswerField;
  position: number;
  allowedAnswerRefs: AnswerReference[];
  correctAnswerRef: AnswerReference;
  hintState: HintState;
};

export class QuestionGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionGenerationError";
  }
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export type QuestionContext = {
  /**
   * The AUTHORITATIVE content identity (content-hash derived, ADR-003).
   * `content_version` is human-readable metadata only and must NEVER identify
   * an exact release, so the determinism key, pinning and attempts key off this.
   */
  releaseId: string;
  contentVersion: string;
  questionGeneratorVersion: string;
  entries: readonly LearnerEntry[];
  entriesById: Map<number, LearnerEntry>;
};

export class UnsupportedGeneratorVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedGeneratorVersionError";
  }
}

export function createQuestionContext(release: {
  release_id: string;
  content_version: string;
  question_generator_version: string;
  entries: readonly LearnerEntry[];
}): QuestionContext {
  // This engine implements exactly one generator algorithm. A release built by
  // a different generator version must NOT be served as if it were this one —
  // that would stamp version-N questions as version-M and break server-side
  // reconstruction. Reject it recoverably (the client can prompt to upgrade).
  if (
    release.question_generator_version !== ENGINE_QUESTION_GENERATOR_VERSION
  ) {
    throw new UnsupportedGeneratorVersionError(
      `release question_generator_version ${release.question_generator_version} is not implemented by this engine (${ENGINE_QUESTION_GENERATOR_VERSION})`,
    );
  }
  return {
    releaseId: release.release_id,
    contentVersion: release.content_version,
    questionGeneratorVersion: release.question_generator_version,
    entries: release.entries,
    entriesById: new Map(release.entries.map((entry) => [entry.id, entry])),
  };
}

export function createQuestionContextFromRelease(
  release: LearnerRelease,
): QuestionContext {
  return createQuestionContext(release);
}

/* ------------------------------------------------------------------ */
/* Field resolution                                                    */
/* ------------------------------------------------------------------ */

function answerFieldForSkill(
  skillType: SkillType,
  sourceField: SourceQuizFormField | null,
): AnswerField {
  switch (skillType) {
    case "meaning_recognition":
      return "meaning";
    case "meaning_recall":
      return sourceField!;
    case "bab_identification":
      return "bab";
    case "root_identification":
      return "root";
    case "verb_type_identification":
      return "verb_type";
  }
}

/**
 * Resolve the prompt field. Recognition prompts with the source form; recall
 * prompts with the meaning; entry-level prompts with a chosen eligible form
 * (default māḍī). Throws if the entry-level prompt form is ineligible — a
 * prompt is never shown with an ineligible field.
 */
function promptFieldForSkill(
  entry: LearnerEntry,
  resolved: ResolvedComponentIdentity,
  requestedPromptForm: SourceQuizFormField | undefined,
): AnswerField {
  if (resolved.componentShape === "form_direction") {
    return resolved.direction === "arabic_to_english"
      ? resolved.sourceField! // recognition: prompt is the Arabic form
      : "meaning"; // recall: prompt is the English meaning
  }
  const promptForm = requestedPromptForm ?? DEFAULT_ENTRY_LEVEL_PROMPT_FORM;
  if (!isFieldEligible(entry, promptForm)) {
    throw new QuestionGenerationError(
      `prompt form ${promptForm} is not eligible for entry ${entry.id}`,
    );
  }
  return promptForm;
}

/* ------------------------------------------------------------------ */
/* Candidate pool                                                      */
/* ------------------------------------------------------------------ */

/**
 * Bāb / verb-type used for PLAUSIBILITY ranking only — gated by eligibility so
 * an unverified classification (e.g. entry 369/372's verb type) can never
 * influence which options are chosen (CLAUDE.md hard rule 2). Bāb is eligible
 * for all entries; verb type is gated for the two unresolved entries.
 */
function rankingBab(entry: LearnerEntry): LearnerEntry["bab"] | null {
  return entry.quiz_eligibility.bab ? entry.bab : null;
}
function rankingVerbType(
  entry: LearnerEntry,
): LearnerEntry["verb_type"] | null {
  return entry.quiz_eligibility.verb_type ? entry.verb_type : null;
}

function candidatePool(
  context: QuestionContext,
  answerField: AnswerField,
): DistractorCandidate[] {
  const candidates: DistractorCandidate[] = [];
  for (const entry of context.entries) {
    if (!isFieldEligible(entry, answerField)) continue;
    candidates.push({
      ref: { entryId: entry.id, field: answerField },
      value: fieldValue(entry, answerField),
      entryId: entry.id,
      bab: rankingBab(entry),
      verbType: rankingVerbType(entry),
      bookPage: entry.book_page,
    });
  }
  return candidates;
}

/**
 * Answer values that would be ambiguous given the prompt: for every other
 * entry whose PROMPT-form surface matches the target's (after normalisation)
 * and whose answer field is eligible, exclude that answer value. This is what
 * keeps duplicate-māḍī groups (262/275, 297/303, 409/413) from ever appearing
 * in each other's option sets where the surface answer would be ambiguous.
 */
function ambiguousAnswerValues(
  context: QuestionContext,
  target: LearnerEntry,
  promptField: AnswerField,
  answerField: AnswerField,
): Set<string> {
  const promptSurface = answerComparisonKey(
    promptField,
    fieldValue(target, promptField),
  );
  const ambiguous = new Set<string>();
  for (const entry of context.entries) {
    if (entry.id === target.id) continue;
    if (!isFieldEligible(entry, promptField)) continue;
    if (
      answerComparisonKey(promptField, fieldValue(entry, promptField)) !==
      promptSurface
    )
      continue;
    if (!isFieldEligible(entry, answerField)) continue;
    ambiguous.add(
      answerComparisonKey(answerField, fieldValue(entry, answerField)),
    );
  }
  return ambiguous;
}

/* ------------------------------------------------------------------ */
/* Core builder                                                        */
/* ------------------------------------------------------------------ */

/**
 * The instance seed folds every input that shapes the rendered question —
 * the caller's `question_seed` plus the structural parameters (delivery mode,
 * position, prompt field) — into one per-instance seed via an INJECTIVE
 * length-prefixed encoding (`canonicalKey`), so distinct tuples can never
 * flatten to the same string. Both the RNG and the instance id derive from
 * `(instanceSeed, generator_version, release_id, component_key)`, so two
 * structurally-different questions can never collide, and the SAME inputs
 * always reproduce one byte-identical question. Enforced inside the generator,
 * not by a caller convention.
 */
function instanceSeedFrom(
  questionSeed: string,
  deliveryMode: DeliveryMode,
  position: number,
  promptField: AnswerField,
): string {
  return canonicalKey([questionSeed, deliveryMode, position, promptField]);
}

function determinismKey(
  instanceSeed: string,
  context: QuestionContext,
  componentKey: string,
): string {
  // Keyed on the AUTHORITATIVE release id (not content_version): two releases
  // that share a content_version but differ in content have different
  // release_ids and therefore different instance identities (ADR-003).
  return canonicalKey([
    instanceSeed,
    context.questionGeneratorVersion,
    context.releaseId,
    componentKey,
  ]);
}

function questionInstanceId(
  instanceSeed: string,
  context: QuestionContext,
  componentKey: string,
): string {
  // 128-bit: structurally-distinct questions must never share an id, even at
  // large scale (a 32-bit hash collides at ordinary volumes).
  return stableHash128Hex(
    canonicalKey(["qid", determinismKey(instanceSeed, context, componentKey)]),
  );
}

function buildQuestion(
  context: QuestionContext,
  resolved: ResolvedComponentIdentity,
  options: {
    deliveryMode: DeliveryMode;
    questionSeed: string;
    position: number;
    requestedPromptForm?: SourceQuizFormField;
  },
): QuestionInstance {
  // Position is part of the identity and is JSON-serialised on the spec; reject
  // values that would not survive a JSON round-trip (NaN/∞ → null, fractional)
  // and -0 (whose sign JSON does not preserve).
  if (
    !Number.isSafeInteger(options.position) ||
    options.position < 0 ||
    Object.is(options.position, -0)
  ) {
    throw new QuestionGenerationError(
      `position must be a non-negative safe integer, got ${String(options.position)}`,
    );
  }
  const mode = questionModeForDelivery(options.deliveryMode);
  const entry = context.entriesById.get(resolved.entryId);
  if (!entry) {
    throw new QuestionGenerationError(
      `entry ${resolved.entryId} is not in the loaded content release`,
    );
  }

  const identity: ComponentIdentity = {
    entryId: resolved.entryId,
    skillType: resolved.skillType,
    sourceField: resolved.sourceField,
    direction: resolved.direction,
  };
  if (!isComponentEligible(entry, identity)) {
    throw new QuestionGenerationError(
      `component ${buildComponentKey(identity)} is not quiz-eligible for entry ${entry.id}`,
    );
  }

  const componentKey = buildComponentKey(identity);
  const answerField = answerFieldForSkill(
    resolved.skillType,
    resolved.sourceField,
  );
  const promptField = promptFieldForSkill(
    entry,
    resolved,
    options.requestedPromptForm,
  );

  const promptRef: AnswerReference = { entryId: entry.id, field: promptField };
  const correctAnswerRef: AnswerReference = {
    entryId: entry.id,
    field: answerField,
  };
  const correctValue = fieldValue(entry, answerField);

  const instanceSeed = instanceSeedFrom(
    options.questionSeed,
    options.deliveryMode,
    options.position,
    promptField,
  );
  const instanceId = questionInstanceId(instanceSeed, context, componentKey);

  const base = {
    questionInstanceId: instanceId,
    questionSeed: options.questionSeed,
    questionGeneratorVersion: context.questionGeneratorVersion,
    releaseId: context.releaseId,
    contentVersion: context.contentVersion,
    componentKey,
    skillType: resolved.skillType,
    componentShape: resolved.componentShape,
    entryId: entry.id,
    sourceField: resolved.sourceField,
    direction: resolved.direction,
    mode,
    deliveryMode: options.deliveryMode,
    promptField,
    promptRef,
    answerField,
    correctAnswerRef,
    position: options.position,
    hintState: freshNoHint(),
  };

  if (mode === "flashcard") {
    if (resolved.componentShape !== "form_direction") {
      throw new QuestionGenerationError(
        "flashcards are only defined for translation (form_direction) components",
      );
    }
    return {
      ...base,
      options: [],
      allowedAnswerRefs: [correctAnswerRef],
    };
  }

  // Multiple choice. Phase 6 ships exactly DEFAULT_OPTION_COUNT options;
  // learner-configurable counts (§4.4) arrive with custom sessions in Phase 11.
  const distractorCount = DEFAULT_OPTION_COUNT - 1;
  const rng = createRng(determinismKey(instanceSeed, context, componentKey));

  const target: DistractorTarget = {
    correctValue,
    correctEntryId: entry.id,
    bab: rankingBab(entry),
    verbType: rankingVerbType(entry),
    bookPage: entry.book_page,
  };
  const excluded = ambiguousAnswerValues(
    context,
    entry,
    promptField,
    answerField,
  );
  const distractors = selectDistractors(
    target,
    candidatePool(context, answerField),
    distractorCount,
    rng,
    excluded,
    (value) => answerComparisonKey(answerField, value),
  );
  if (distractors.length < distractorCount) {
    throw new QuestionGenerationError(
      `insufficient distractors for component ${componentKey} (needed ${distractorCount}, found ${distractors.length})`,
    );
  }

  const correctOption: QuestionOption = {
    ref: correctAnswerRef,
    displayValue: correctValue,
    isCorrect: true,
  };
  const distractorOptions: QuestionOption[] = distractors.map((candidate) => ({
    ref: candidate.ref,
    displayValue: candidate.value,
    isCorrect: false,
  }));
  const optionsList = rng.shuffle([correctOption, ...distractorOptions]);

  assertOptionInvariants(optionsList, answerField, correctValue);

  return {
    ...base,
    options: optionsList,
    allowedAnswerRefs: optionsList.map((option) => option.ref),
  };
}

function assertOptionInvariants(
  options: readonly QuestionOption[],
  answerField: AnswerField,
  correctValue: string,
): void {
  if (options.length !== DEFAULT_OPTION_COUNT) {
    throw new QuestionGenerationError(
      `expected ${DEFAULT_OPTION_COUNT} options, built ${options.length}`,
    );
  }
  const keys = options.map((option) =>
    answerComparisonKey(answerField, option.displayValue),
  );
  if (new Set(keys).size !== keys.length) {
    throw new QuestionGenerationError(
      "options are not unique after normalisation",
    );
  }
  const correctCount = options.filter((option) => option.isCorrect).length;
  if (correctCount !== 1) {
    throw new QuestionGenerationError(
      `exactly one correct option required, found ${correctCount}`,
    );
  }
  const correctKey = answerComparisonKey(answerField, correctValue);
  const correctPresent = keys.filter((value) => value === correctKey).length;
  if (correctPresent !== 1) {
    throw new QuestionGenerationError(
      "the correct value must appear exactly once in the options",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export const DELIVERY_MODES = ["mc", "flashcard", "timed", "test"] as const;

export type GenerateQuestionRequest = {
  identity: ComponentIdentity;
  /**
   * The effective delivery mode (mc / flashcard / timed / test). It selects the
   * question structure AND is folded into the instance identity, so a plain-MC,
   * timed, and test question with the same seed/component/position/prompt are
   * distinct instances.
   */
  deliveryMode: DeliveryMode;
  /**
   * The base seed for this question. The generator folds delivery mode,
   * position and the resolved prompt field into it internally, so distinct
   * positions or prompt forms yield distinct questions/ids even from the same
   * base seed — callers need not encode anything themselves.
   */
  questionSeed: string;
  position: number;
  /** Entry-level prompt form (bāb/root/verb-type). Ignored for translations. */
  promptForm?: SourceQuizFormField;
};

/** Generate a question for a component. Deterministic in every input. */
export function generateQuestion(
  context: QuestionContext,
  request: GenerateQuestionRequest,
): QuestionInstance {
  // Validate at the public boundary (types don't protect JS/deserialized
  // callers) so generate → serialise → replay always round-trips: never emit a
  // spec that `generateFromSpec` would then refuse to regenerate.
  if (typeof request.questionSeed !== "string") {
    throw new QuestionGenerationError(
      `questionSeed must be a string, got ${typeof request.questionSeed}`,
    );
  }
  if (!(DELIVERY_MODES as readonly string[]).includes(request.deliveryMode)) {
    throw new QuestionGenerationError(
      `deliveryMode ${JSON.stringify(request.deliveryMode)} is not a known mode`,
    );
  }
  const resolved = resolveComponentIdentity(request.identity);
  return buildQuestion(context, resolved, {
    deliveryMode: request.deliveryMode,
    questionSeed: request.questionSeed,
    position: request.position,
    requestedPromptForm: request.promptForm,
  });
}

/** The serialisable spec that regenerates a question exactly. */
export function specForQuestion(instance: QuestionInstance): QuestionSpec {
  return {
    questionInstanceId: instance.questionInstanceId,
    questionSeed: instance.questionSeed,
    questionGeneratorVersion: instance.questionGeneratorVersion,
    releaseId: instance.releaseId,
    contentVersion: instance.contentVersion,
    componentKey: instance.componentKey,
    deliveryMode: instance.deliveryMode,
    promptField: instance.promptField,
    position: instance.position,
    allowedAnswerRefs: instance.allowedAnswerRefs,
    correctAnswerRef: instance.correctAnswerRef,
    hintState: instance.hintState,
  };
}

function promptFormFromSpec(
  spec: QuestionSpec,
  resolved: ResolvedComponentIdentity,
): SourceQuizFormField | undefined {
  if (resolved.componentShape !== "entry_level") return undefined;
  if (!isSourceFormField(spec.promptField)) {
    throw new QuestionGenerationError(
      `entry-level prompt field ${spec.promptField} is not a source form`,
    );
  }
  return spec.promptField;
}

/**
 * Regenerate a question from its recorded spec. Verifies generator + content
 * version agreement, then reproduces the identical instance.
 */
export function generateFromSpec(
  context: QuestionContext,
  spec: QuestionSpec,
): QuestionInstance {
  if (spec.questionGeneratorVersion !== context.questionGeneratorVersion) {
    throw new QuestionGenerationError(
      `spec generator version ${spec.questionGeneratorVersion} != context ${context.questionGeneratorVersion}`,
    );
  }
  // The AUTHORITATIVE identity is release_id — reconstruction must run against
  // the exact release that produced the spec (ADR-003).
  if (spec.releaseId !== context.releaseId) {
    throw new QuestionGenerationError(
      `spec release ${spec.releaseId} != context release ${context.releaseId}`,
    );
  }
  if (spec.contentVersion !== context.contentVersion) {
    throw new QuestionGenerationError(
      `spec content version ${spec.contentVersion} != context ${context.contentVersion}`,
    );
  }
  // Runtime-validate deserialized structural fields before regenerating — a
  // JSON spec crossing an untyped boundary may carry a mistyped seed, an
  // unknown delivery mode, or a contradictory/invalid hint state.
  if (typeof spec.questionSeed !== "string") {
    throw new QuestionGenerationError(
      `spec question_seed must be a string, got ${typeof spec.questionSeed}`,
    );
  }
  if (typeof spec.componentKey !== "string") {
    throw new QuestionGenerationError("spec component_key must be a string");
  }
  if (!(DELIVERY_MODES as readonly string[]).includes(spec.deliveryMode)) {
    throw new QuestionGenerationError(
      `spec delivery mode ${JSON.stringify(spec.deliveryMode)} is not a known mode`,
    );
  }
  assertValidHintState(spec.hintState);
  const resolved = parseComponentKey(spec.componentKey);
  const regenerated = buildQuestion(context, resolved, {
    deliveryMode: spec.deliveryMode,
    questionSeed: spec.questionSeed,
    position: spec.position,
    requestedPromptForm: promptFormFromSpec(spec, resolved),
  });

  // Tamper detection: the recorded derived fields must match what regeneration
  // produces. Any divergence means the spec was altered after generation.
  if (regenerated.questionInstanceId !== spec.questionInstanceId) {
    throw new QuestionGenerationError(
      `spec question_instance_id ${spec.questionInstanceId} != regenerated ${regenerated.questionInstanceId}`,
    );
  }
  // The recorded prompt field must match for EVERY component shape — for
  // form_direction it is fixed by the skill/direction, so a tampered value
  // (e.g. madi→mudari) must be rejected, not silently normalised away.
  if (regenerated.promptField !== spec.promptField) {
    throw new QuestionGenerationError(
      `spec prompt_field ${spec.promptField} != regenerated ${regenerated.promptField}`,
    );
  }
  const refsEqual = (a: AnswerReference[], b: AnswerReference[]) =>
    a.length === b.length &&
    a.every(
      (ref, i) => ref.entryId === b[i].entryId && ref.field === b[i].field,
    );
  if (!refsEqual(regenerated.allowedAnswerRefs, spec.allowedAnswerRefs)) {
    throw new QuestionGenerationError(
      "spec allowed_answer_refs disagree with the regenerated option set",
    );
  }
  if (
    regenerated.correctAnswerRef.entryId !== spec.correctAnswerRef.entryId ||
    regenerated.correctAnswerRef.field !== spec.correctAnswerRef.field
  ) {
    throw new QuestionGenerationError(
      "spec correct_answer_ref disagrees with the regenerated question",
    );
  }

  // Restore the recorded hint state (dynamic session state, not a generation
  // input) so the replayed instance matches the original exactly.
  return { ...regenerated, hintState: spec.hintState };
}

/** Serialise an answer reference to its stable string form (re-export). */
export { serializeAnswerReference };

/** The set of answer fields (helper for tools/tests). */
export const ALL_ANSWER_FIELDS: readonly AnswerField[] = ANSWER_FIELDS;

/** The generator version this build produces (matches the content pipeline). */
export const ENGINE_QUESTION_GENERATOR_VERSION = QUESTION_GENERATOR_VERSION;
