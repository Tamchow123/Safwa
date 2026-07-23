/**
 * Phase 16 — pure push-batch builder (§9.1, EXT-F2). Turns the client's
 * scheduling selection + queued mutations into ONE bounded `PushRequest`,
 * enforcing every wire cap (per-kind + total `maxItemsPerBatch`). Pure and
 * unit-testable in isolation — no Dexie, no network.
 *
 * FAIRNESS (REL-001). Scheduling events + their attempts are an ATOMIC unit (an
 * attempt sent without its event would be misread as a reinforcement attempt),
 * so the batch never truncates them mid-way; instead the orchestrator caps how
 * many scheduling EVENTS it selects via `schedulingEventLimit` so a heavy
 * offline scheduling backlog always leaves batch room for the small,
 * latency-sensitive queued mutations (an undo revocation, a setting change).
 * Within the batch, scheduling is placed first and the remaining budget is filled
 * with the queued categories.
 */
import {
  SYNC_BOUNDS,
  SYNC_PROTOCOL_VERSION,
  type PushRequest,
  type WireAttempt,
  type WireEvent,
} from "@/modules/sync/protocol";

import type { QueuedMutations } from "./mutation-queue";

/**
 * Batch room reserved for queued mutations when scheduling is also pending, so a
 * large scheduling backlog can never fully starve latency-sensitive mutations
 * across consecutive pushes. Adapts down to the actual mutation demand.
 */
export const MUTATION_BATCH_RESERVE = 250;

type Bounds = {
  maxItemsPerBatch: number;
  maxAttempts: number;
  maxRevocations: number;
  maxBookmarks: number;
  maxLists: number;
  maxSettings: number;
};

/**
 * How many scheduling EVENTS to select this push. Reserves batch room for the
 * `mutationCount` pending queued mutations (capped at `MUTATION_BATCH_RESERVE`)
 * so they are not starved; each event carries at most one attempt, so bounding
 * events to `(maxItemsPerBatch - reserve) / 2` keeps scheduling's items within
 * the non-reserved budget. Never exceeds `pushLimit`.
 */
export function schedulingEventLimit(
  mutationCount: number,
  pushLimit: number,
  bounds: Bounds = SYNC_BOUNDS,
): number {
  const reserve = Math.min(Math.max(0, mutationCount), MUTATION_BATCH_RESERVE);
  const nonReserved = Math.max(0, bounds.maxItemsPerBatch - reserve);
  return Math.min(pushLimit, Math.floor(nonReserved / 2));
}

export type PushSelection = {
  deviceId: string;
  events: WireEvent[];
  schedulingAttempts: WireAttempt[];
  queued: QueuedMutations;
};

/**
 * Build the bounded push request, or null when there is nothing to send.
 * Scheduling (already atomic and pre-limited by `schedulingEventLimit`) is
 * placed first; each queued category then takes from the remaining total budget,
 * bounded by its own wire cap. Reinforcement attempts share the attempt cap with
 * scheduling attempts.
 */
export function buildBoundedPushRequest(
  selection: PushSelection,
  bounds: Bounds = SYNC_BOUNDS,
): PushRequest | null {
  const { events, schedulingAttempts, queued } = selection;
  let budget =
    bounds.maxItemsPerBatch - events.length - schedulingAttempts.length;
  const take = <T>(items: T[], cap: number): T[] => {
    const n = Math.max(0, Math.min(items.length, cap, budget));
    budget -= n;
    return items.slice(0, n);
  };
  // Order matters within the reserved budget (REL-002): the small, latency-
  // sensitive categories (an undo revocation, a setting/collection change another
  // device may be waiting to see) take their share BEFORE the higher-volume,
  // non-undo-critical reinforcement attempts, so a large reinforcement backlog
  // can never crowd a pending revocation out of a push.
  const revocations = take(queued.revocations, bounds.maxRevocations);
  const settings = take(queued.settings, bounds.maxSettings);
  const lists = take(queued.lists, bounds.maxLists);
  const bookmarks = take(queued.bookmarks, bounds.maxBookmarks);
  const reinforcementAttempts = take(
    queued.reinforcementAttempts,
    bounds.maxAttempts - schedulingAttempts.length,
  );
  const attempts = [...schedulingAttempts, ...reinforcementAttempts];

  const hasWork =
    events.length > 0 ||
    attempts.length > 0 ||
    revocations.length > 0 ||
    bookmarks.length > 0 ||
    lists.length > 0 ||
    settings.length > 0;
  if (!hasWork) return null;

  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    deviceId: selection.deviceId,
    attempts,
    events,
    revocations,
    bookmarks,
    lists,
    settings,
  };
}
