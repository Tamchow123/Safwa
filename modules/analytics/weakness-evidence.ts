/**
 * Weakness evidence preparation (Phase 13 §7–9) — turns the raw analytics
 * snapshot into ONE prepared evidence record per touched component, so every
 * downstream weakness consumer (heuristic scoring, aggregation, drill
 * planning) reads the same honest, attributed evidence instead of
 * re-interpreting raw attempt/event rows independently.
 *
 * REUSE, NOT A SECOND READ PATH: this consumes the SAME
 * `AnalyticsPersistenceSnapshot` (`modules/analytics/persistence.ts`) and the
 * SAME joined `EffectiveComponent[]` (`modules/analytics/progress.ts`) that
 * the dashboard/progress formulas already read — so Dashboard, Progress and
 * Weak Areas can never disagree about whether an attempt or component is
 * valid.
 *
 * VALIDITY (§7): reuses `isValidActivityAttempt` (structurally usable id +
 * component key + immutable date + finite response time, and no
 * revoked/sync-rejected linked event) — the same gate daily activity uses.
 * On top of that, weakness evidence additionally requires a valid immutable
 * UTC instant, a first (non-reinforcement) attempt, and a component that is
 * still derivable from the current release (a key absent from `effective`
 * — stale, ineligible, or from an unsupported content release — is
 * excluded, never joined by numeric id alone).
 *
 * SOURCE-FORM ATTRIBUTION (§9, load-bearing): a translation
 * (`form_direction`) component's evidence is attributed to
 * `attempt.sourceField`. An entry-level component (bāb/root/verb-type) has
 * no source field of its own — its evidence is attributed to
 * `attempt.promptField` ONLY when that field is one of the six source
 * forms, so a bāb attempt prompted with māḍī and a later one prompted with
 * muḍāriʿ produce separate, correctly attributed evidence instead of both
 * collapsing onto a default form.
 *
 * Pure TypeScript: no React, Dexie, DOM or ambient clocks.
 */
import {
  SOURCE_QUIZ_FORM_FIELDS,
  type Direction,
  type SkillType,
  type SourceQuizFormField,
} from "@/modules/content/constants";
import { isUsableCard } from "@/modules/scheduler/states";
import type { LearnerState } from "@/modules/scheduler/states";

import {
  isValidActivityAttempt,
  type AnalyticsAttempt,
  type AnalyticsEvent,
} from "@/modules/analytics/activity";
import type { EffectiveComponent } from "@/modules/analytics/progress";

/** One valid, attributed first attempt feeding weakness evidence (§8–9). */
export type WeaknessAttemptEvidence = {
  attemptId: string;
  componentKey: string;
  entryId: number;
  skillType: SkillType;
  direction: Direction | null;
  /** The attributed source form for grouping/scoring, or null when none applies. */
  analysisForm: SourceQuizFormField | null;
  isCorrect: boolean;
  /** The attempt's immutable recorded UTC instant, epoch milliseconds. */
  occurredAtMs: number;
};

/** Prepared per-component weakness evidence (§8). */
export type WeaknessComponentEvidence = {
  componentKey: string;
  entryId: number;
  skillType: SkillType;
  direction: Direction | null;
  /** The component's own translation field (form_direction only), else null. */
  sourceField: SourceQuizFormField | null;
  effectiveState: LearnerState;
  /** Current FSRS lapse count; invalid/missing fails safe to 0. */
  fsrsLapses: number;
  /** Valid, non-reinforcement first attempts only, in snapshot order. */
  firstAttempts: WeaknessAttemptEvidence[];
};

function isSourceQuizFormField(
  value: string | null,
): value is SourceQuizFormField {
  return (
    value !== null &&
    (SOURCE_QUIZ_FORM_FIELDS as readonly string[]).includes(value)
  );
}

/** Parse an immutable ISO instant to finite epoch milliseconds, or null. */
function parseInstant(value: string | null): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The §9 attribution rule: translation components use the attempt's own
 * `sourceField`; entry-level components use `promptField` only when it is
 * one of the six source forms (never the component's identity, which would
 * collapse every prompt form onto whichever field happens to be default).
 */
function resolveAnalysisForm(
  component: EffectiveComponent,
  attempt: AnalyticsAttempt,
): SourceQuizFormField | null {
  if (component.componentShape === "form_direction") {
    return attempt.sourceField;
  }
  return isSourceQuizFormField(attempt.promptField)
    ? attempt.promptField
    : null;
}

function safeLapses(component: EffectiveComponent): number {
  const card = component.card;
  if (!card || !isUsableCard(card)) return 0;
  if (!Number.isFinite(card.lapses) || card.lapses < 0) return 0;
  return card.lapses;
}

/**
 * Prepare weakness evidence for every component that has been touched
 * (≥1 valid first attempt, or a positive FSRS lapse count). Untouched
 * components — including brand-new, materialised-but-never-attempted, and
 * components not derivable from the current release — produce no entry, so
 * they can never surface as weak by construction (§10 "untouched is not
 * weak"; §23 content-version handling).
 */
export function prepareWeaknessEvidence(
  effective: readonly EffectiveComponent[],
  attempts: readonly AnalyticsAttempt[],
  events: readonly AnalyticsEvent[],
): ReadonlyMap<string, WeaknessComponentEvidence> {
  const componentByKey = new Map(effective.map((c) => [c.key, c] as const));

  const eventByAttemptId = new Map<string, AnalyticsEvent>();
  for (const event of events) {
    if (typeof event.attemptId === "string" && event.attemptId.length > 0) {
      eventByAttemptId.set(event.attemptId, event);
    }
  }

  const attemptsByComponent = new Map<string, WeaknessAttemptEvidence[]>();
  for (const attempt of attempts) {
    if (!isValidActivityAttempt(attempt, eventByAttemptId.get(attempt.id))) {
      continue;
    }
    if (!attempt.isFirstAttempt || attempt.isReinforcement) continue;
    if (attempt.entryId === null || attempt.skillType === null) continue;

    const occurredAtMs = parseInstant(attempt.occurredAtUtc);
    if (occurredAtMs === null) continue;

    const component = componentByKey.get(attempt.componentKey);
    if (!component) continue; // stale/ineligible/unsupported-release component

    // Identity fields come from the already-joined, componentKey-validated
    // `component` — not the raw attempt row — so a corrupt/legacy attempt
    // whose entryId/skillType/direction happen to disagree with its own
    // componentKey can never carry a mismatched identity into weakness
    // scoring/grouping. Only `sourceField`/`promptField` are genuinely
    // attempt-specific (§9 attribution) and stay attempt-sourced.
    const evidence: WeaknessAttemptEvidence = {
      attemptId: attempt.id,
      componentKey: attempt.componentKey,
      entryId: component.entryId,
      skillType: component.skillType,
      direction: component.direction,
      analysisForm: resolveAnalysisForm(component, attempt),
      isCorrect: attempt.isCorrect,
      occurredAtMs,
    };

    const list = attemptsByComponent.get(attempt.componentKey) ?? [];
    attemptsByComponent.set(attempt.componentKey, list);
    list.push(evidence);
  }

  const candidateKeys = new Set(attemptsByComponent.keys());
  for (const component of effective) {
    if (safeLapses(component) > 0) candidateKeys.add(component.key);
  }

  const result = new Map<string, WeaknessComponentEvidence>();
  for (const key of candidateKeys) {
    const component = componentByKey.get(key);
    if (!component) continue;
    result.set(key, {
      componentKey: key,
      entryId: component.entryId,
      skillType: component.skillType,
      direction: component.direction,
      sourceField: component.sourceField,
      effectiveState: component.state,
      fsrsLapses: safeLapses(component),
      firstAttempts: attemptsByComponent.get(key) ?? [],
    });
  }
  return result;
}
