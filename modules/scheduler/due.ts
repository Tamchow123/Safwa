/**
 * Due-item selection and mixed-revision ordering (PRODUCT_REQUIREMENTS.md §4.3
 * "start studying", §4.4 daily targets). A mixed session orders
 * **due → weak → new** within the user's daily targets (default 10 new /
 * 20 reviews).
 *
 * The weak tier is EVIDENCE-based: a non-due, non-mastered card qualifies only
 * when its caller-supplied weakness score (recent first-attempt accuracy;
 * higher = weaker) is positive, or when the component is projected
 * `needs_review`. A card that has only ever been answered correctly
 * (score 0, `learning`) is never re-drilled before its FSRS due time merely
 * because it has not reached mastery. The full weak-areas page is Phase 13.
 *
 * New-item ordering is likewise CALLER-supplied (`newRank`, lower first) —
 * the pedagogical policy lives with the planner (see
 * `modules/study-session/mixed.ts`); raw component-key order is only the
 * deterministic tiebreak of last resort and never a pedagogical order.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import { isDue, type SchedulerCard } from "@/modules/scheduler/fsrs";
import type { LearnerState } from "@/modules/scheduler/states";

export type DailyTargets = {
  newLimit: number;
  reviewLimit: number;
};

export const DEFAULT_DAILY_TARGETS: DailyTargets = {
  newLimit: 10,
  reviewLimit: 20,
};

export type SchedulableItem = {
  componentKey: string;
  /** Null for a not-started (new) component. */
  card: SchedulerCard | null;
  state: LearnerState;
  /** Weakness score (higher = weaker); optional, defaults to 0. */
  weakScore?: number;
  /**
   * Caller-supplied pedagogical rank for NEW (card-less) items — lower runs
   * first. Unranked new items sort after every ranked one.
   */
  newRank?: number;
};

/** Components whose card is due at (or before) the injected instant. */
export function selectDue(
  items: readonly SchedulableItem[],
  nowMs: number,
): SchedulableItem[] {
  return items
    .filter((item) => item.card !== null && isDue(item.card, nowMs))
    .sort(
      (a, b) =>
        a.card!.dueAtMs - b.card!.dueAtMs ||
        a.componentKey.localeCompare(b.componentKey, "en"),
    );
}

/**
 * Is a non-due card WEAK — i.e. is there actual evidence the learner
 * struggles with it? Positive weakness score (a recent incorrect first
 * attempt; reinforcement recoveries never erase it) or a `needs_review`
 * projection qualifies. Mastered components never do.
 */
function isWeakEvidence(item: SchedulableItem): boolean {
  if (item.state === "mastered") return false;
  return (item.weakScore ?? 0) > 0 || item.state === "needs_review";
}

/** Unranked new items sort after every ranked one (deterministic key tiebreak). */
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Build a zero-config mixed session: due first (most overdue first), then
 * weak non-due items (weakest first) — only those with actual weakness
 * evidence — filling the review budget; then new (not-started) items in the
 * caller's pedagogical rank order, filling the new budget. Deterministic
 * ordering.
 */
export function buildMixedSession(
  items: readonly SchedulableItem[],
  nowMs: number,
  targets: DailyTargets = DEFAULT_DAILY_TARGETS,
): string[] {
  const due = selectDue(items, nowMs);
  const dueKeys = new Set(due.map((item) => item.componentKey));

  // Weak: a non-due item that HAS a card AND carries weakness evidence
  // (positive score, or a needs_review projection), weakest first. Disjoint
  // from `due` (those are due) and from `new` (those have no card). A
  // score-zero `learning` card — answered correctly and simply not yet due —
  // is deliberately NOT re-drilled early.
  const weak = items
    .filter(
      (item) =>
        item.card !== null &&
        !dueKeys.has(item.componentKey) &&
        isWeakEvidence(item),
    )
    .sort(
      (a, b) =>
        (b.weakScore ?? 0) - (a.weakScore ?? 0) ||
        a.componentKey.localeCompare(b.componentKey, "en"),
    );

  // Reviews budget covers due then weak.
  const reviews = [...due, ...weak].slice(0, Math.max(0, targets.reviewLimit));

  // New: only never-reviewed components (no card), in the caller's rank order
  // — never raw key order, which is only the deterministic final tiebreak. A
  // card that exists — even a wrong-only `not_started` one — is a review/weak
  // item, never "new", so no component can appear in two tiers.
  const newItems = items
    .filter((item) => item.card === null)
    .sort(
      (a, b) =>
        (a.newRank ?? UNRANKED) - (b.newRank ?? UNRANKED) ||
        a.componentKey.localeCompare(b.componentKey, "en"),
    )
    .slice(0, Math.max(0, targets.newLimit));

  return [
    ...reviews.map((item) => item.componentKey),
    ...newItems.map((item) => item.componentKey),
  ];
}
