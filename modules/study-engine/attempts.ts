/**
 * Attempt-record creation — every submitted answer (DATA_MODEL.md §5).
 *
 * Records are stable REFERENCES (entry + field), never copied Arabic text, so
 * the server resolves them through the assessment manifest. Event-time
 * timezone metadata (`local_date_at_event`, offset, source) is computed once,
 * here, from an INJECTED clock + IANA zone — the engine never reads Date.now
 * or the ambient locale (a lint rule forbids it), which keeps attempt creation
 * deterministic and testable. Changing the user's timezone affects only future
 * attempts; a recorded `local_date_at_event` is immutable history.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { AnswerReference } from "@/modules/content/answer-reference";
import type {
  Direction,
  SkillType,
  SourceQuizFormField,
} from "@/modules/content/constants";

import {
  assertValidHintState,
  type DeliveryMode,
  type HintState,
  type HintType,
  type QuestionInstance,
} from "@/modules/study-engine/generator";

/**
 * Attempt delivery mode (DATA_MODEL.md §5) — the same set as the question's
 * delivery mode, so the recorded attempt mode matches the instance exactly.
 */
export type AttemptMode = DeliveryMode;

/**
 * Canonical runtime list of timezone-metadata sources — import this array;
 * never re-declare the literals (two copies would drift).
 */
export const TIMEZONE_SOURCES = [
  "browser_detected",
  "user_setting",
  "server_fallback",
] as const;
export type TimezoneSource = (typeof TIMEZONE_SOURCES)[number];

/** Injected wall-clock + zone. `now` returns epoch milliseconds (UTC). */
export type AttemptClock = {
  now: () => number;
  timezone: string;
  timezoneSource: TimezoneSource;
};

export type EventTimeFields = {
  occurredAtUtc: string;
  timezoneAtEvent: string;
  utcOffsetMinutesAtEvent: number;
  localDateAtEvent: string;
  timezoneSource: TimezoneSource;
};

/**
 * The engine-produced attempt (DATA_MODEL.md §5). `userId` carries the §5
 * `user_id (or local profile pre-merge)` association: the signed-in user id
 * when known, else null for a guest — whose local-profile association is the
 * `deviceId`. Both are injected; the pure engine invents neither.
 */
export type AttemptRecord = {
  id: string;
  sessionId: string;
  /** Signed-in user id, or null for a guest (see `deviceId`). */
  userId: string | null;
  deviceId: string;
  studyComponentId: string;
  entryId: number;
  skillTypeId: SkillType;
  sourceField: SourceQuizFormField | null;
  direction: Direction | null;
  promptField: AnswerReference["field"];
  promptRef: AnswerReference;
  selectedAnswerRef: AnswerReference | null;
  correctAnswerRef: AnswerReference;
  isCorrect: boolean;
  isFirstAttempt: boolean;
  isReinforcement: boolean;
  hintUsed: boolean;
  hintType: HintType | null;
  responseTimeMs: number;
  questionPosition: number;
  mode: AttemptMode;
  /**
   * MC option count the question was generated with (§4.4, Phase 11) — a
   * QUESTION-IDENTITY input, persisted so a recorded attempt regenerates its
   * exact question even after the learner changes the option-count setting.
   * Records written before Phase 11 lack this field: absent means 4 (the
   * only count that existed).
   */
  optionCount: number;
  /**
   * The per-question limit (ms) this TIMED attempt was graded against, null
   * for untimed/flashcard attempts (§4.4, Phase 11 configurable limit).
   * Persisted so the future authoritative server (Phase 16) can re-derive
   * timed correctness from `response_time_ms >= limit` without trusting the
   * client. Records written before Phase 11 lack this field: absent means
   * 20000 for timed-mode attempts (the only limit that existed), null
   * otherwise.
   */
  perQuestionLimitMs: number | null;
  questionInstanceId: string;
  questionSeed: string;
  questionGeneratorVersion: string;
  /** Authoritative content identity the attempt was generated against (ADR-003). */
  releaseId: string;
  contentVersion: string;
} & EventTimeFields;

const TWO_DIGIT = "2-digit";

/**
 * Per-zone formatter cache. Intl.DateTimeFormat construction (locale + ICU
 * data resolution) is comparatively expensive, and bulk callers — the
 * dashboard's due-today count maps thousands of card instants in ONE zone —
 * must pay it once per zone, not once per instant. Deterministic: a formatter
 * is a pure function of its zone string, so memoisation cannot change any
 * output. Bounded defensively: zones only reach here validated, but an
 * unexpected flood of distinct zone strings must not grow memory forever.
 */
const eventTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function eventTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = eventTimeFormatters.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: TWO_DIGIT,
    day: TWO_DIGIT,
    hour: TWO_DIGIT,
    minute: TWO_DIGIT,
    second: TWO_DIGIT,
  });
  if (eventTimeFormatters.size >= 32) eventTimeFormatters.clear();
  eventTimeFormatters.set(timezone, formatter);
  return formatter;
}

/**
 * Compute the event-time date fields for an instant in an IANA zone. Uses Intl
 * (a deterministic JS built-in) with an explicit `timeZone`; the offset is the
 * difference between the zone's wall clock and UTC at that instant.
 */
export function computeEventTimeFields(
  epochMs: number,
  clock: Pick<AttemptClock, "timezone" | "timezoneSource">,
): EventTimeFields {
  const instant = new Date(epochMs);
  const formatter = eventTimeFormatter(clock.timezone);
  const parts = formatter.formatToParts(instant);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") lookup[part.type] = part.value;
  }
  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const day = Number(lookup.day);
  const hour = Number(lookup.hour);
  const minute = Number(lookup.minute);
  const second = Number(lookup.second);

  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const flooredInstant = Math.floor(epochMs / 1000) * 1000;
  const utcOffsetMinutesAtEvent = Math.round(
    (wallClockAsUtc - flooredInstant) / 60000,
  );

  const localDateAtEvent =
    `${String(year).padStart(4, "0")}-` +
    `${String(month).padStart(2, "0")}-` +
    `${String(day).padStart(2, "0")}`;

  return {
    occurredAtUtc: instant.toISOString(),
    timezoneAtEvent: clock.timezone,
    utcOffsetMinutesAtEvent,
    localDateAtEvent,
    timezoneSource: clock.timezoneSource,
  };
}

export type CreateAttemptInput = {
  id: string;
  sessionId: string;
  /** Signed-in user id, or null for a guest. */
  userId: string | null;
  deviceId: string;
  instance: QuestionInstance;
  /** Null for flashcards (self-graded) and for a timed/unanswered lapse. */
  selectedAnswerRef: AnswerReference | null;
  isCorrect: boolean;
  isFirstAttempt: boolean;
  isReinforcement: boolean;
  hint: HintState;
  responseTimeMs: number;
  /** The per-question limit the attempt was graded against (null = untimed). */
  perQuestionLimitMs: number | null;
  // NOTE: the delivery mode is NOT accepted here — it is taken from
  // `instance.deliveryMode`, which was folded into the instance id. A separate
  // mode input could contradict the identity the id was derived from.
};

/** Assemble a full attempt record, stamping event-time fields from the clock. */
export function createAttemptRecord(
  input: CreateAttemptInput,
  clock: AttemptClock,
): AttemptRecord {
  const { instance } = input;
  if (!Number.isFinite(input.responseTimeMs) || input.responseTimeMs < 0) {
    throw new Error("responseTimeMs must be a non-negative finite number");
  }
  assertValidHintState(input.hint);
  const eventTime = computeEventTimeFields(clock.now(), clock);
  return {
    id: input.id,
    sessionId: input.sessionId,
    userId: input.userId,
    deviceId: input.deviceId,
    studyComponentId: instance.componentKey,
    entryId: instance.entryId,
    skillTypeId: instance.skillType,
    sourceField: instance.sourceField,
    direction: instance.direction,
    promptField: instance.promptField,
    promptRef: instance.promptRef,
    selectedAnswerRef: input.selectedAnswerRef,
    correctAnswerRef: instance.correctAnswerRef,
    isCorrect: input.isCorrect,
    isFirstAttempt: input.isFirstAttempt,
    isReinforcement: input.isReinforcement,
    hintUsed: input.hint.used,
    hintType: input.hint.type,
    responseTimeMs: input.responseTimeMs,
    questionPosition: instance.position,
    // Always the instance's delivery mode — never a contradictory input.
    mode: instance.deliveryMode,
    optionCount: instance.optionCount,
    perQuestionLimitMs: input.perQuestionLimitMs,
    questionInstanceId: instance.questionInstanceId,
    questionSeed: instance.questionSeed,
    questionGeneratorVersion: instance.questionGeneratorVersion,
    releaseId: instance.releaseId,
    contentVersion: instance.contentVersion,
    ...eventTime,
  };
}
