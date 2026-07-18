/**
 * Due-item selection and mixed-revision ordering (PRODUCT_REQUIREMENTS.md §4.3
 * "start studying", §4.4 daily targets). A mixed session orders
 * **due → weak → new** within the user's daily targets (default 10 new /
 * 20 reviews). The weak-item heuristic v1 is a caller-supplied per-component
 * weakness score (recent first-attempt accuracy); the full weak-areas page is
 * Phase 13.
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
 * Build a zero-config mixed session: due first (most overdue first), then weak
 * non-due items (weakest first), filling the review budget; then new
 * (not-started) items filling the new budget. Deterministic ordering.
 */
export function buildMixedSession(
  items: readonly SchedulableItem[],
  nowMs: number,
  targets: DailyTargets = DEFAULT_DAILY_TARGETS,
): string[] {
  const due = selectDue(items, nowMs);
  const dueKeys = new Set(due.map((item) => item.componentKey));

  // Weak: any non-due item that HAS a card but is NOT mastered (learning, a
  // not-yet-due lapse, or a wrong-only card that has not yet had a clean
  // success), weakest first. Disjoint from `due` (those are due) and from `new`
  // (those have no card).
  const weak = items
    .filter(
      (item) =>
        item.card !== null &&
        !dueKeys.has(item.componentKey) &&
        item.state !== "mastered",
    )
    .sort(
      (a, b) =>
        (b.weakScore ?? 0) - (a.weakScore ?? 0) ||
        a.componentKey.localeCompare(b.componentKey, "en"),
    );

  // Reviews budget covers due then weak.
  const reviews = [...due, ...weak].slice(0, Math.max(0, targets.reviewLimit));

  // New: only never-reviewed components (no card). A card that exists — even a
  // wrong-only `not_started` one — is a review/weak item, never "new", so no
  // component can appear in two tiers.
  const newItems = items
    .filter((item) => item.card === null)
    .sort((a, b) => a.componentKey.localeCompare(b.componentKey, "en"))
    .slice(0, Math.max(0, targets.newLimit));

  return [
    ...reviews.map((item) => item.componentKey),
    ...newItems.map((item) => item.componentKey),
  ];
}
