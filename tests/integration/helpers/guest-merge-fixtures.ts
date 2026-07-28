/**
 * Phase 17 — the guest-side wire records the merge integration suites send.
 *
 * Shared because two suites were building them independently and the field
 * lists had already started to differ (CLEAN-001-T16). These are the shapes the
 * SERVER validates, so a drift between two copies is a drift between what one
 * suite proves and what the other does.
 *
 * The question fixture is passed in rather than resolved here: each suite picks
 * its own generatable component in its own `beforeAll`, and which one it picked
 * is part of that suite's setup, not of these builders.
 */
import type { QuestionInstance } from "@/modules/study-engine/generator";
import {
  buildComponentKey,
  type ResolvedComponentIdentity,
} from "@/modules/study-engine";

/** Everything a builder needs about the suite's chosen question. */
export type GuestMergeFixture = {
  identity: ResolvedComponentIdentity;
  instance: QuestionInstance;
  releaseId: string;
  contentVersion: string;
  /** The question seed the instance was generated with. */
  seed: string;
};

/**
 * A well-formed guest attempt for the fixture component — one the server will
 * accept, so a test that wants a REFUSAL has to say which field makes it one.
 */
export function makeGuestAttempt(
  fixture: GuestMergeFixture,
  id: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  const { identity, instance } = fixture;
  return {
    id,
    sessionId,
    deviceId: "device-1",
    studyComponentId: buildComponentKey(identity),
    entryId: identity.entryId,
    skillTypeId: identity.skillType,
    sourceField: identity.sourceField,
    direction: identity.direction,
    promptField: instance.promptField,
    promptRef: instance.promptRef,
    selectedAnswerRef: instance.correctAnswerRef,
    correctAnswerRef: instance.correctAnswerRef,
    isCorrect: true,
    isFirstAttempt: true,
    isReinforcement: false,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 3000,
    questionPosition: 0,
    mode: "mc" as const,
    optionCount: instance.optionCount,
    perQuestionLimitMs: null,
    questionInstanceId: instance.questionInstanceId,
    questionSeed: fixture.seed,
    questionGeneratorVersion: "1",
    releaseId: fixture.releaseId,
    contentVersion: fixture.contentVersion,
    occurredAtUtc: "2026-07-20T11:00:00.000Z",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected" as const,
    ...overrides,
  };
}

/** A guest scheduling event referencing one of those attempts. */
export function makeGuestEvent(
  fixture: GuestMergeFixture,
  eventId: string,
  attemptId: string,
  sessionId: string,
  parentEventId: string | null,
  revision: number,
  occurredAtClient: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    eventId,
    studyComponentId: buildComponentKey(fixture.identity),
    attemptId,
    rating: "good" as const,
    status: "scheduling" as const,
    baseServerRevision: 0,
    parentEventId,
    clientComponentRevision: revision,
    clientSequence: revision,
    occurredAtClient,
    deviceId: "device-1",
    sessionId,
    releaseId: fixture.releaseId,
    contentVersion: fixture.contentVersion,
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected" as const,
    ...overrides,
  };
}

/**
 * A genuinely WRONG option from the fixture question's own set — not merely a
 * malformed reference.
 *
 * The distinction decides what a trust-boundary test proves: an out-of-set
 * reference is refused at validation and never reaches grading, so it cannot
 * demonstrate that a false correctness claim is CORRECTED (REL-001-T16).
 */
export function aDistractor(fixture: GuestMergeFixture) {
  const { instance } = fixture;
  const wrong = instance.allowedAnswerRefs.find(
    (ref) =>
      ref.entryId !== instance.correctAnswerRef.entryId ||
      ref.field !== instance.correctAnswerRef.field,
  );
  if (!wrong) throw new Error("the fixture question has no distractor");
  return wrong;
}
