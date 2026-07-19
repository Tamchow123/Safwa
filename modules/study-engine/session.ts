/**
 * The study-session state machine (pure, no scheduling — Phase 7 owns FSRS).
 *
 * Responsibilities (PRODUCT_REQUIREMENTS.md §4.6):
 *   - first-attempt tracking per component per session;
 *   - wrong-then-correct reinforcement re-queue (§4.6, in EVERY mode): a wrong
 *     FIRST attempt reintroduces the component once, later in the session; the
 *     recovery attempt is flagged `is_reinforcement` so Phase 7 produces NO
 *     second scheduling event;
 *   - single-step undo (exactly the last action, deterministically);
 *   - timed mode (MC only; flashcards self-paced): a timed session always has
 *     a positive-finite per-question limit (default 20s, §4.4); expiry is
 *     DERIVED SOLELY from the injected `responseTimeMs` against that limit
 *     (never a caller override) and counts as incorrect. Timed and test COMBINE
 *     (Phase 11 custom sessions, §4.4) as the `timed_test` delivery mode;
 *   - test mode: per-question correctness feedback is withheld until the
 *     session ends (reinforcement still happens, per §4.6). The attempt record
 *     still carries `is_correct` (persistence needs it in every mode), but
 *     `submitAnswer` returns `feedback: null` during an active test session;
 *     `revealResults` exposes per-question correctness only once complete.
 *
 * Attempt IDs are INJECTED (`SubmitAnswerInput.attemptId`, a UUID from the
 * persistence layer) — the pure engine never mints ids from ambient crypto.
 *
 * State is plain, serialisable data and every transition is a pure function of
 * (state, context, input) — the content context and the injected clock are
 * arguments, never stored — so sessions replay identically.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import type { SourceQuizFormField } from "@/modules/content/constants";

import {
  createAttemptRecord,
  type AttemptClock,
  type AttemptMode,
  type AttemptRecord,
} from "@/modules/study-engine/attempts";
import {
  createEntryAnswerResolver,
  deriveObjectiveCorrectness,
  flashcardSelfGradeIsCorrect,
  type FlashcardSelfGrade,
} from "@/modules/study-engine/correctness";
import {
  assertValidHintState,
  DEFAULT_OPTION_COUNT,
  freshNoHint,
  generateQuestion,
  MAX_OPTION_COUNT,
  MIN_OPTION_COUNT,
  type HintState,
  type QuestionContext,
  type QuestionInstance,
} from "@/modules/study-engine/generator";
import {
  resolveComponentIdentity,
  type ComponentIdentity,
} from "@/modules/study-engine/natural-key";
import type { AnswerReference } from "@/modules/content/answer-reference";

export type SessionMode = "flashcard" | "mc";

export type SessionConfig = {
  mode: SessionMode;
  /** Per-question correctness feedback withheld until session end (§4.4). */
  testMode: boolean;
  /** Per-question countdown active; a response past the limit is incorrect. */
  timed: boolean;
  perQuestionLimitMs: number | null;
  /** MC options per question (§4.4 — default 4, learner-configurable). */
  optionCount: number;
};

/** Documented default per-question limit for timed mode (§4.4). */
export const DEFAULT_TIMED_LIMIT_MS = 20000;

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  mode: "mc",
  testMode: false,
  timed: false,
  perQuestionLimitMs: null,
  optionCount: DEFAULT_OPTION_COUNT,
};

export type PlannedItem = {
  identity: ComponentIdentity;
  /** Entry-level prompt form (bāb/root/verb-type). Ignored for translations. */
  promptForm?: SourceQuizFormField;
  kind: "initial" | "reinforcement";
};

export type SessionState = {
  sessionId: string;
  seed: string;
  deviceId: string;
  /** Signed-in user id, or null for a guest (local-profile association). */
  userId: string | null;
  /**
   * The content release this session is PINNED to (OFFLINE_AND_SYNC §2). The
   * AUTHORITATIVE identity is `releaseId` (content-hash derived, ADR-003);
   * `contentVersion` is human-readable metadata that may repeat across
   * releases, so pinning keys off `releaseId`.
   */
  releaseId: string;
  contentVersion: string;
  questionGeneratorVersion: string;
  config: SessionConfig;
  plan: PlannedItem[];
  currentIndex: number;
  attempts: AttemptRecord[];
  /** Component keys that have already had their first attempt this session. */
  firstAttemptedComponents: string[];
  status: "active" | "complete";
  /** Single-step undo snapshot (its own `previous` is always null). */
  previous: SessionState | null;
};

export type CreateSessionInput = {
  sessionId: string;
  seed: string;
  deviceId: string;
  /** Signed-in user id, or null/omitted for a guest. */
  userId?: string | null;
  config?: Partial<SessionConfig>;
  items: {
    identity: ComponentIdentity;
    promptForm?: SourceQuizFormField;
  }[];
};

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export function createSession(
  input: CreateSessionInput,
  context: QuestionContext,
): SessionState {
  const config: SessionConfig = { ...DEFAULT_SESSION_CONFIG, ...input.config };
  // Timed mode is a quiz feature; flashcards are self-paced (§4.3).
  if (config.timed && config.mode === "flashcard") {
    throw new SessionError("timed mode does not apply to flashcard sessions");
  }
  // Test mode withholds objective correctness feedback; flashcards are
  // self-graded (no objective correctness to withhold), so the combination is
  // meaningless and would not be represented in the single delivery-mode enum.
  if (config.testMode && config.mode === "flashcard") {
    throw new SessionError("test mode does not apply to flashcard sessions");
  }
  // Timed + test COMBINE (Phase 11, §4.4): the composition is recorded as the
  // dedicated `timed_test` delivery mode, so no attempt is mis-labelled.
  if (
    !Number.isSafeInteger(config.optionCount) ||
    config.optionCount < MIN_OPTION_COUNT ||
    config.optionCount > MAX_OPTION_COUNT
  ) {
    throw new SessionError(
      `optionCount must be an integer in [${MIN_OPTION_COUNT}, ${MAX_OPTION_COUNT}], got ${String(config.optionCount)}`,
    );
  }
  if (config.timed) {
    // A timed session always has a valid, positive, finite limit — default the
    // documented 20s (§4.4) and reject any invalid explicit value.
    if (config.perQuestionLimitMs === null) {
      config.perQuestionLimitMs = DEFAULT_TIMED_LIMIT_MS;
    } else if (
      !Number.isFinite(config.perQuestionLimitMs) ||
      config.perQuestionLimitMs <= 0
    ) {
      throw new SessionError(
        `timed sessions need a positive finite per-question limit, got ${String(config.perQuestionLimitMs)}`,
      );
    }
  }
  const plan: PlannedItem[] = input.items.map((item) => {
    // Flashcards are translation-only (§4.3): reject entry-level items up front
    // rather than failing later at question generation.
    if (
      config.mode === "flashcard" &&
      resolveComponentIdentity(item.identity).componentShape !==
        "form_direction"
    ) {
      throw new SessionError(
        "flashcard sessions accept only translation (form_direction) components",
      );
    }
    return {
      identity: item.identity,
      promptForm: item.promptForm,
      kind: "initial",
    };
  });
  return {
    sessionId: input.sessionId,
    seed: input.seed,
    deviceId: input.deviceId,
    userId: input.userId ?? null,
    releaseId: context.releaseId,
    contentVersion: context.contentVersion,
    questionGeneratorVersion: context.questionGeneratorVersion,
    config,
    plan,
    currentIndex: 0,
    attempts: [],
    firstAttemptedComponents: [],
    status: plan.length === 0 ? "complete" : "active",
    previous: null,
  };
}

/**
 * Enforce the session's content pinning (OFFLINE_AND_SYNC §2): a session never
 * mixes releases — a context from a different content/generator version is
 * rejected rather than silently generating/grading against a different release.
 */
function assertPinnedContext(
  state: SessionState,
  context: QuestionContext,
): void {
  if (
    context.releaseId !== state.releaseId ||
    context.questionGeneratorVersion !== state.questionGeneratorVersion
  ) {
    throw new SessionError(
      `session is pinned to release ${state.releaseId} / generator ${state.questionGeneratorVersion}, ` +
        `but was given release ${context.releaseId} / generator ${context.questionGeneratorVersion}`,
    );
  }
}

/** The question for the current position, or null when the session is done. */
export function currentQuestion(
  state: SessionState,
  context: QuestionContext,
): QuestionInstance | null {
  if (state.status === "complete" || state.currentIndex >= state.plan.length) {
    return null;
  }
  assertPinnedContext(state, context);
  const item = state.plan[state.currentIndex];
  // The generator folds delivery mode/position/prompt form into its instance
  // seed, so the session's stable base seed suffices — distinct positions,
  // prompt forms and delivery modes yield distinct questions (and ids).
  return generateQuestion(context, {
    identity: item.identity,
    deliveryMode: deliveryModeFor(state.config),
    questionSeed: state.seed,
    position: state.currentIndex,
    promptForm: item.promptForm,
    optionCount: state.config.optionCount,
  });
}

export type SubmitAnswerInput = {
  /** Injected attempt id (a UUID from the persistence layer). */
  attemptId: string;
  /**
   * The `questionInstanceId` the learner was actually shown. Bound to the
   * current question so a stale/duplicate UI action (e.g. answering after the
   * session already advanced) is rejected rather than graded against a
   * different, unseen question.
   */
  questionInstanceId: string;
  /** MC selection. Required for MC unless the timed limit has elapsed. */
  selectedAnswerRef?: AnswerReference;
  /** Flashcard self-grade. Required for flashcard mode. */
  selfGrade?: FlashcardSelfGrade;
  hint?: HintState;
  /** Elapsed answer time (ms). In timed mode, `>= limit` is a lapse (incorrect). */
  responseTimeMs: number;
  clock: AttemptClock;
};

/** Per-question correctness feedback (withheld — null — during test mode). */
export type QuestionFeedback = {
  isCorrect: boolean;
  correctAnswerRef: AnswerReference;
  selectedAnswerRef: AnswerReference | null;
};

export type SubmitAnswerResult = {
  state: SessionState;
  attempt: AttemptRecord;
  /** Null while a test session is active (feedback withheld until the end). */
  feedback: QuestionFeedback | null;
};

/** The effective delivery mode for this session (question id + attempt record). */
function deliveryModeFor(config: SessionConfig): AttemptMode {
  if (config.mode === "flashcard") return "flashcard";
  if (config.timed && config.testMode) return "timed_test";
  if (config.timed) return "timed";
  if (config.testMode) return "test";
  return "mc";
}

function snapshotForUndo(state: SessionState): SessionState {
  // Strip the nested previous so undo is strictly single-step.
  return { ...state, previous: null };
}

/**
 * Whether an MC answer counts as a timed lapse. Derived SOLELY from the
 * injected response time against the configured per-question limit — never a
 * caller-supplied override — so correctness cannot be contradicted by caller
 * state. The limit is guaranteed positive-finite by `createSession`.
 */
function hasTimedOut(config: SessionConfig, responseTimeMs: number): boolean {
  return (
    config.timed &&
    config.perQuestionLimitMs !== null &&
    responseTimeMs >= config.perQuestionLimitMs
  );
}

/**
 * Submit an answer for the current question, appending an attempt and
 * advancing. A wrong first attempt outside test mode re-queues the component
 * once for in-session reinforcement.
 */
export function submitAnswer(
  state: SessionState,
  context: QuestionContext,
  input: SubmitAnswerInput,
): SubmitAnswerResult {
  if (state.status === "complete") {
    throw new SessionError("cannot submit: the session is already complete");
  }
  const instance = currentQuestion(state, context);
  if (!instance) {
    throw new SessionError("no current question to answer");
  }
  // Bind the submission to the question actually shown — reject a stale or
  // duplicate action meant for a different (already-answered) question.
  if (input.questionInstanceId !== instance.questionInstanceId) {
    throw new SessionError(
      `submission is for question ${input.questionInstanceId}, but the current question is ${instance.questionInstanceId}`,
    );
  }
  if (!Number.isFinite(input.responseTimeMs) || input.responseTimeMs < 0) {
    throw new SessionError(
      "responseTimeMs must be a non-negative finite number",
    );
  }
  // Default ONLY when the property is omitted (undefined); any supplied value —
  // including null — must pass strict validation, never be silently coerced.
  const hint: HintState =
    input.hint === undefined ? freshNoHint() : assertValidHintState(input.hint);

  let isCorrect: boolean;
  let selectedAnswerRef: AnswerReference | null;

  if (state.config.mode === "flashcard") {
    if (input.selfGrade === undefined) {
      throw new SessionError("flashcard mode requires a self grade");
    }
    isCorrect = flashcardSelfGradeIsCorrect(input.selfGrade);
    selectedAnswerRef = null;
  } else if (hasTimedOut(state.config, input.responseTimeMs)) {
    // Timed lapse (response time >= the configured limit): counts as incorrect,
    // with no selection recorded.
    isCorrect = false;
    selectedAnswerRef = null;
  } else {
    if (input.selectedAnswerRef === undefined) {
      throw new SessionError("mc mode requires a selected answer reference");
    }
    const resolver = createEntryAnswerResolver(context.entriesById);
    const outcome = deriveObjectiveCorrectness(
      instance,
      input.selectedAnswerRef,
      resolver,
    );
    isCorrect = outcome.isCorrect;
    selectedAnswerRef = input.selectedAnswerRef;
  }

  const item = state.plan[state.currentIndex];
  const componentKey = instance.componentKey;
  const isFirstAttempt = !state.firstAttemptedComponents.includes(componentKey);
  // Reinforcement means a RECOVERY re-queue (kind === "reinforcement"), NOT
  // merely any repeated exposure — a component independently planned twice
  // (e.g. bāb with two prompt forms) is a fresh "initial" item, never a
  // reinforcement, even though it is not the component's first attempt.
  const isReinforcement = item.kind === "reinforcement";

  const attempt = createAttemptRecord(
    {
      id: input.attemptId,
      sessionId: state.sessionId,
      deviceId: state.deviceId,
      userId: state.userId,
      instance,
      selectedAnswerRef,
      isCorrect,
      isFirstAttempt,
      isReinforcement,
      hint,
      responseTimeMs: input.responseTimeMs,
      // The GRADING limit this attempt was judged against — persisted so the
      // authoritative server can re-derive timed correctness independently
      // (the limit is learner-configurable from Phase 11).
      perQuestionLimitMs: state.config.timed
        ? state.config.perQuestionLimitMs
        : null,
    },
    input.clock,
  );

  const plan = [...state.plan];
  // Re-queue for reinforcement whenever a FIRST attempt is wrong (§4.6). Test
  // mode still reintroduces the item — it only withholds correctness feedback
  // (§4.4), not the reinforcement itself.
  const shouldReinforce = !isCorrect && isFirstAttempt;
  if (shouldReinforce) {
    plan.push({
      identity: item.identity,
      promptForm: item.promptForm,
      kind: "reinforcement",
    });
  }

  const firstAttemptedComponents = isFirstAttempt
    ? [...state.firstAttemptedComponents, componentKey]
    : state.firstAttemptedComponents;

  const nextIndex = state.currentIndex + 1;
  const nextState: SessionState = {
    ...state,
    plan,
    currentIndex: nextIndex,
    attempts: [...state.attempts, attempt],
    firstAttemptedComponents,
    status: nextIndex >= plan.length ? "complete" : "active",
    previous: snapshotForUndo(state),
  };

  // Test mode withholds ALL per-question feedback; it is revealed only via
  // revealResults() once the session completes. Other modes give immediate
  // feedback (§4.6).
  const feedback: QuestionFeedback | null = state.config.testMode
    ? null
    : {
        isCorrect,
        correctAnswerRef: instance.correctAnswerRef,
        selectedAnswerRef,
      };

  return { state: nextState, attempt, feedback };
}

/**
 * Per-question feedback for a completed session. In test mode this is the ONLY
 * way to see correctness (it was withheld inline); it throws if a test session
 * is still active. Ordered by attempt.
 */
export function revealResults(state: SessionState): QuestionFeedback[] {
  if (state.config.testMode && state.status !== "complete") {
    throw new SessionError(
      "test-mode results are withheld until the session completes",
    );
  }
  return state.attempts.map((attempt) => ({
    isCorrect: attempt.isCorrect,
    correctAnswerRef: attempt.correctAnswerRef,
    selectedAnswerRef: attempt.selectedAnswerRef,
  }));
}

/** True when a single-step undo is available. */
export function canUndo(state: SessionState): boolean {
  return state.previous !== null;
}

/**
 * Undo the last action, restoring the exact prior state (one attempt fewer).
 * Single-step only: the restored state cannot itself be undone.
 */
export function undo(state: SessionState): SessionState {
  if (!state.previous) {
    throw new SessionError("nothing to undo (single-step undo already used)");
  }
  return state.previous;
}

/* ------------------------------------------------------------------ */
/* Summary (for results screens and scripted transcripts)             */
/* ------------------------------------------------------------------ */

export type SessionSummary = {
  totalAttempts: number;
  firstAttemptCorrect: number;
  recovered: number;
  repeatedIncorrect: number;
  hinted: number;
  componentsSeen: number;
};

/**
 * Aggregate a session's attempts. `recovered` = components whose first attempt
 * was wrong but a later reinforcement attempt was correct; `repeatedIncorrect`
 * = components wrong on the first attempt and never recovered in-session.
 */
export function summarizeSession(state: SessionState): SessionSummary {
  const firstAttempts = state.attempts.filter((a) => a.isFirstAttempt);
  const firstAttemptCorrect = firstAttempts.filter((a) => a.isCorrect).length;
  const hinted = state.attempts.filter((a) => a.hintUsed).length;

  const recoveredComponents = new Set<string>();
  for (const attempt of state.attempts) {
    if (attempt.isReinforcement && attempt.isCorrect) {
      recoveredComponents.add(attempt.studyComponentId);
    }
  }
  const wrongFirst = firstAttempts.filter((a) => !a.isCorrect);
  const repeatedIncorrect = wrongFirst.filter(
    (a) => !recoveredComponents.has(a.studyComponentId),
  ).length;

  return {
    totalAttempts: state.attempts.length,
    firstAttemptCorrect,
    recovered: recoveredComponents.size,
    repeatedIncorrect,
    hinted,
    componentsSeen: state.firstAttemptedComponents.length,
  };
}
