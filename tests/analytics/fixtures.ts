/**
 * Shared `AnalyticsAttempt`/`AnalyticsEvent` fixture builders (Phase 12 §8,
 * Phase 13 §7-9) — the ONE source of default field values every analytics
 * test file overrides from, so a shape change to either type only needs
 * updating here instead of drifting silently across test files.
 */
import type {
  AnalyticsAttempt,
  AnalyticsEvent,
} from "@/modules/analytics/activity";

// Shared across both builders, incremented on every call to generate unique
// attempt/event ids (interleaved: attempt-1, event-2, attempt-3, ...).
let counter = 0;

export function attempt(
  overrides: Partial<AnalyticsAttempt> = {},
): AnalyticsAttempt {
  counter += 1;
  return {
    id: `attempt-${counter}`,
    componentKey: "entry:1:skill:bab_identification",
    localDateAtEvent: "2026-07-17",
    responseTimeMs: 1500,
    occurredAtUtc: "2026-07-17T12:00:00.000Z",
    entryId: 1,
    skillType: "bab_identification",
    direction: null,
    sourceField: null,
    promptField: "madi",
    isFirstAttempt: true,
    isReinforcement: false,
    isCorrect: true,
    ...overrides,
  };
}

export function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  counter += 1;
  return {
    eventId: `event-${counter}`,
    attemptId: null,
    parentEventId: null,
    status: "scheduling",
    syncStatus: "local",
    localDateAtEvent: "2026-07-17",
    ...overrides,
  };
}
