/**
 * The local causal event chain and its deterministic FSRS replay
 * (DATA_MODEL.md §8, OFFLINE_AND_SYNC.md §5). Phase 7 chains are SEQUENTIAL and
 * single-device: each scheduling event's parent is the preceding local
 * scheduling event (or null for the root). Replaying the accepted `scheduling`
 * events in causal order reproduces the component's FSRS card state
 * bit-for-bit. Concurrent-branch detection / conflict demotion is Phase 19.
 *
 * Phase 17 (phases-17.md §14) adds ONE further legitimate shape: a guest→account
 * MERGE UNION. An explicit identity merge unions two histories that were built
 * independently — the account's chain and the imported guest's chain — for the
 * same component, preserving both sides' original event ids and their internal
 * parent links (§9.4). The result is a set of DISJOINT chains, not one sequential
 * chain, so it cannot satisfy `orderCausally`'s single-root/contiguous-revision
 * invariants. {@link partitionScheduling} therefore classifies an event set as
 * one of three {@link ChainShape}s — `strict` (validated exactly as before),
 * `partial` (one chain whose earlier history lives elsewhere) or `union` (the
 * merge) — and rejects everything else as the corruption it is: a fork (two
 * events sharing a parent, i.e. the concurrent branch Phase 19 owns), a cycle, a
 * duplicate event id, a revision that goes backwards, a gap in a self-contained
 * chain. A `union` additionally requires the caller to opt in
 * ({@link ChainReplayOptions.allowMergeUnion}), so ordinary sync still fails
 * loudly on a shape it must never see (§14). A union replays in deterministic
 * canonical order ({@link orderForReplay}), which is what makes "the final server
 * component state equals replay of the accepted union" (§14) well defined and
 * reproducible on both sides of the wire.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import { deriveLineage, type EventLineage } from "@/modules/scheduler/events";
import type { ReviewEvent } from "@/modules/scheduler/events";
import {
  isDue,
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

/** Epoch-ms instant of an event (parsed from its immutable client timestamp). */
function eventInstantMs(event: ReviewEvent): number {
  const ms = Date.parse(event.occurredAtClient);
  if (Number.isNaN(ms)) {
    throw new ChainError(
      `event ${event.eventId} has an unparseable occurred_at ${JSON.stringify(event.occurredAtClient)}`,
    );
  }
  return ms;
}

/**
 * Order the accepted `scheduling` events of ONE component into causal order and
 * validate the sequential-chain invariants: strictly increasing, contiguous
 * `client_component_revision`s starting at 1, the root's parent is null, and
 * every other event's parent is its immediate predecessor. A branch (two events
 * sharing a parent) is rejected as out-of-scope for Phase 7 (Phase 19).
 */
export function orderCausally(events: readonly ReviewEvent[]): ReviewEvent[] {
  const scheduling = events.filter((event) => event.status === "scheduling");
  if (scheduling.length === 0) return [];

  const ordered = [...scheduling].sort(
    (a, b) => a.clientComponentRevision - b.clientComponentRevision,
  );

  const seenRevisions = new Set<number>();
  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i];
    if (seenRevisions.has(event.clientComponentRevision)) {
      throw new ChainError(
        `duplicate client_component_revision ${event.clientComponentRevision} (concurrent branches are Phase 19)`,
      );
    }
    seenRevisions.add(event.clientComponentRevision);

    if (event.clientComponentRevision !== i + 1) {
      throw new ChainError(
        `non-contiguous chain: expected revision ${i + 1}, got ${event.clientComponentRevision}`,
      );
    }
    const expectedParent = i === 0 ? null : ordered[i - 1].eventId;
    if (event.parentEventId !== expectedParent) {
      throw new ChainError(
        `broken causal link at revision ${event.clientComponentRevision}: parent ${JSON.stringify(event.parentEventId)} != ${JSON.stringify(expectedParent)}`,
      );
    }
  }
  return ordered;
}

/**
 * The shape of a component's accepted `scheduling` event set.
 *
 * - `strict` — ONE sequential chain rooted at revision 1: the Phase 7 local
 *   chain and the Stage-A server chain. Exactly what {@link orderCausally}
 *   accepts, and the only shape ordinary sync ever produces.
 * - `partial` — one chain that does not contain its own whole history: it is
 *   rooted on an event outside the set, or starts above revision 1. A device
 *   bootstrapped from a pulled lineage anchor (R2-F2) holds this. Replaying it
 *   from a fresh card is a PARTIAL replay, so it must never overwrite the
 *   server-authoritative card — but it is not corruption, and it must not throw
 *   (before Phase 17 it did, which made a second local review on a bootstrapped
 *   component fail).
 * - `union` — two or more disjoint chains: the guest→account MERGE UNION (§14),
 *   and nothing else. Because ordinary sync must never produce or tolerate one
 *   (§14 "Do not make this behaviour available to ordinary sync requests"), it
 *   is REJECTED unless the caller explicitly opts in with
 *   {@link ChainReplayOptions.allowMergeUnion} — so the merge pipeline enables
 *   it deliberately while every other caller keeps failing loudly on a shape it
 *   should never see.
 */
export type ChainShape = "strict" | "partial" | "union";

/** Options shared by every entry point that partitions an event set. */
export type ChainReplayOptions = {
  /**
   * Permit a `union` (≥2 disjoint chains). Default FALSE: only the explicit
   * guest→account merge — server-side ingestion of an import and the local
   * paths of a component that has been merged — may set it.
   */
  allowMergeUnion?: boolean;
};

/** One internally-sequential chain: root first, each event's parent its predecessor. */
export type SchedulingChain = {
  events: ReviewEvent[];
  /**
   * True when the chain contains its OWN whole history: its root has no parent
   * AND starts at revision 1. False for an anchor-rooted chain (root parents an
   * event outside the set) or one that starts above revision 1 — either way its
   * earlier history is elsewhere, so replaying it from a fresh card is partial.
   */
  complete: boolean;
};

export type ChainPartition = {
  shape: ChainShape;
  /** The disjoint chains, each in causal order; ordered by their root's revision then id. */
  chains: SchedulingChain[];
  /**
   * Every chain is `complete`, so the whole set is SELF-CONTAINED and replaying
   * it from a fresh card reproduces the true card. When false the set is only
   * part of a history, so its replay is NOT authoritative: the caller must keep
   * the server's card rather than persist this projection.
   */
  complete: boolean;
};

/**
 * Is this event the ROOT of a chain within `present` — the set of events being
 * considered? True when it has no parent at all, and also when its parent is
 * outside the set, because then its earlier history lives somewhere else and it
 * begins a chain here regardless.
 *
 * Exported for the same reason as {@link compareChainOrder}: the server counts
 * roots to decide WHICH head rule applies (`modules/sync/server/chain-head.ts`)
 * and this function decides what a root is, so a second transcription could
 * drift and make the server classify a component differently from the client
 * that derived the event — the stuck-component failure this pairing exists to
 * prevent. `present` is anything with a `has`, so a `Map` of events and a `Set`
 * of accepted ids both qualify.
 */
export function isChainRoot(
  parentEventId: string | null,
  present: { has(eventId: string): boolean },
): boolean {
  return !linksToParent(parentEventId, present);
}

/**
 * The same question asked the other way round, as a type guard: an event LINKS
 * when its parent exists inside `present`, which is also the only case in which
 * `parentEventId` is known to be a string. {@link isChainRoot} is its negation,
 * so the rule is still written once; both names exist because a boolean return
 * cannot narrow the id for the caller that then indexes by it.
 */
export function linksToParent(
  parentEventId: string | null,
  present: { has(eventId: string): boolean },
): parentEventId is string {
  return parentEventId !== null && present.has(parentEventId);
}

/**
 * Partition a component's `scheduling` events into their causal chains, or throw
 * {@link ChainError} when the set is structurally impossible — or is a merge
 * union the caller did not opt into.
 *
 * Rejected exactly as in Phase 7: a duplicate event id, a fork (two events
 * sharing one parent — the concurrent branch Phase 19 resolves, never silently
 * replayed), a cycle, a revision that does not strictly increase along a chain,
 * a gap in a self-contained chain's revisions, and an unparseable event instant.
 * Newly accepted: a `partial` chain (always), and a `union` (only with
 * `allowMergeUnion`).
 */
export function partitionScheduling(
  events: readonly ReviewEvent[],
  options: ChainReplayOptions = {},
): ChainPartition {
  const scheduling = events.filter((event) => event.status === "scheduling");
  if (scheduling.length === 0) {
    return { shape: "strict", chains: [], complete: true };
  }

  const byId = new Map<string, ReviewEvent>();
  for (const event of scheduling) {
    if (byId.has(event.eventId)) {
      throw new ChainError(`duplicate event id ${event.eventId}`);
    }
    // Validate the instant HERE, not only at replay time: a merge union is
    // ORDERED by it, so an unparseable timestamp is a structural defect of the
    // set — and validating once keeps every entry point (order, replay, head,
    // lineage) failing identically instead of only the ones that read the clock.
    eventInstantMs(event);
    byId.set(event.eventId, event);
  }

  // Child index + fork detection. A parent outside the set does not link (its
  // child becomes a chain root whose history is elsewhere).
  const childByParent = new Map<string, ReviewEvent>();
  const roots: ReviewEvent[] = [];
  for (const event of scheduling) {
    const parentId = event.parentEventId;
    if (!linksToParent(parentId, byId)) {
      roots.push(event);
      continue;
    }
    if (parentId === event.eventId) {
      throw new ChainError(`event ${event.eventId} is its own parent`);
    }
    const existing = childByParent.get(parentId);
    if (existing) {
      throw new ChainError(
        `events ${existing.eventId} and ${event.eventId} share parent ${parentId} (concurrent branches are Phase 19)`,
      );
    }
    childByParent.set(parentId, event);
  }
  if (roots.length === 0) {
    // Every event has a parent inside the set ⇒ the links form a cycle.
    throw new ChainError("cycle detected: no chain root");
  }

  const visited = new Set<string>();
  const chains: SchedulingChain[] = [];
  for (const root of roots) {
    const chain: ReviewEvent[] = [];
    let cursor: ReviewEvent | undefined = root;
    while (cursor) {
      if (visited.has(cursor.eventId)) {
        throw new ChainError(`cycle detected at event ${cursor.eventId}`);
      }
      visited.add(cursor.eventId);
      const previous = chain[chain.length - 1];
      if (
        previous &&
        cursor.clientComponentRevision <= previous.clientComponentRevision
      ) {
        throw new ChainError(
          `non-monotonic chain: revision ${cursor.clientComponentRevision} does not follow ${previous.clientComponentRevision}`,
        );
      }
      chain.push(cursor);
      cursor = childByParent.get(cursor.eventId);
    }
    // A chain that contains its own whole history (rooted, from revision 1) must
    // ALSO be contiguous — a gap there means an event was lost, which is the
    // corruption `orderCausally` has always rejected. A partial chain (rooted
    // elsewhere / starting higher) can only be required to increase.
    const complete =
      root.parentEventId === null && root.clientComponentRevision === 1;
    if (complete) {
      chain.forEach((event, index) => {
        if (event.clientComponentRevision !== index + 1) {
          throw new ChainError(
            `non-contiguous chain: expected revision ${index + 1}, got ${event.clientComponentRevision}`,
          );
        }
      });
    }
    chains.push({ events: chain, complete });
  }
  if (visited.size !== scheduling.length) {
    // Unreachable events remain ⇒ they form a cycle among themselves.
    throw new ChainError("cycle detected among unreachable events");
  }

  // Deterministic chain order (the merge below is stable regardless, but a
  // stable partition keeps the structure itself reproducible).
  chains.sort((a, b) => {
    const rootA = a.events[0];
    const rootB = b.events[0];
    if (rootA.clientComponentRevision !== rootB.clientComponentRevision) {
      return rootA.clientComponentRevision - rootB.clientComponentRevision;
    }
    return rootA.eventId < rootB.eventId
      ? -1
      : rootA.eventId > rootB.eventId
        ? 1
        : 0;
  });

  const complete = chains.every((chain) => chain.complete);
  const shape: ChainShape =
    chains.length > 1 ? "union" : complete ? "strict" : "partial";
  if (shape === "union" && options.allowMergeUnion !== true) {
    // §14: only an explicit identity merge may union two histories. Ordinary
    // sync reaching this means the accepted set grew a second root it should
    // never have — fail loudly rather than silently replay a wrong card.
    throw new ChainError(
      `${chains.length} disjoint chains: a merge union is only replayable where it is explicitly permitted`,
    );
  }
  return { shape, chains, complete };
}

/** One chain's next unmerged event, as held on the merge heap. */
type MergeCandidate = {
  event: ReviewEvent;
  instantMs: number;
  chainIndex: number;
  positionInChain: number;
};

/** The three keys the canonical order compares, and nothing else. */
export type ChainOrderKey = {
  instantMs: number;
  revision: number;
  eventId: string;
};

/**
 * THE canonical order, on the minimal shape it needs. Exported so the SERVER's
 * head selection (`modules/sync/server/chain-head.ts`) can call this exact
 * function rather than transcribe the rule into a second implementation: the
 * client derives a new event's parent from this order and the server decides
 * whether that parent is the head, so the two agreeing is not a nicety — a
 * divergence makes a merged component silently stop accepting reviews. A shared
 * function makes drift impossible; a shared comment only makes it unlikely.
 *
 * The server compares database rows with canonical times and the client compares
 * `ReviewEvent` records, so the shapes differ; the KEYS do not.
 */
export function compareChainOrder(a: ChainOrderKey, b: ChainOrderKey): number {
  if (a.instantMs !== b.instantMs) return a.instantMs - b.instantMs;
  if (a.revision !== b.revision) return a.revision - b.revision;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Canonical order of two candidates: earlier instant first, then the lower
 * `clientComponentRevision`, then the lower `eventId`. Total and deterministic —
 * two distinct events can never compare equal (event ids are unique within the
 * set), which is what makes the merged order a pure function of the event set
 * rather than of the input array's order.
 */
function compareCandidates(a: MergeCandidate, b: MergeCandidate): number {
  return compareChainOrder(
    {
      instantMs: a.instantMs,
      revision: a.event.clientComponentRevision,
      eventId: a.event.eventId,
    },
    {
      instantMs: b.instantMs,
      revision: b.event.clientComponentRevision,
      eventId: b.event.eventId,
    },
  );
}

/** Minimal binary min-heap over {@link compareCandidates} (push/pop are O(log k)). */
class CandidateHeap {
  private readonly items: MergeCandidate[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: MergeCandidate): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareCandidates(this.items[index], this.items[parent]) >= 0) break;
      [this.items[index], this.items[parent]] = [
        this.items[parent],
        this.items[index],
      ];
      index = parent;
    }
  }

  pop(): MergeCandidate | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (
          left < this.items.length &&
          compareCandidates(this.items[left], this.items[smallest]) < 0
        ) {
          smallest = left;
        }
        if (
          right < this.items.length &&
          compareCandidates(this.items[right], this.items[smallest]) < 0
        ) {
          smallest = right;
        }
        if (smallest === index) break;
        [this.items[index], this.items[smallest]] = [
          this.items[smallest],
          this.items[index],
        ];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * The events of a partition in the deterministic order they must be replayed in.
 *
 * A single chain replays in its own causal order. A `union` replays in CANONICAL
 * order: the chains are merged by event instant, with
 * `(clientComponentRevision, eventId)` as the tiebreak, and each chain's own
 * causal order is never violated (only a chain's NEXT event is ever on the heap).
 * Reviews are therefore applied chronologically, exactly as they were
 * experienced, while the result stays a pure function of the event set — the
 * property Phase 17 §14 relies on when it says the merged state is "whatever
 * replay of the accepted union produces", reproducible identically by the server
 * and by the client.
 *
 * A heap, not a per-step scan of every chain: the number of chains is bounded by
 * the number of events, so a linear scan would be O(n·k) — quadratic for a
 * pathological set — while this is O(n log k) whatever shape the set has. That
 * matters because the server replays inside a per-component advisory-locked
 * transaction.
 */
function mergeChainsCanonically(
  chains: readonly SchedulingChain[],
): ReviewEvent[] {
  const heap = new CandidateHeap();
  chains.forEach((chain, chainIndex) => {
    const event = chain.events[0];
    if (event) {
      heap.push({
        event,
        instantMs: eventInstantMs(event),
        chainIndex,
        positionInChain: 0,
      });
    }
  });

  const merged: ReviewEvent[] = [];
  for (;;) {
    const next = heap.pop();
    if (next === undefined) break;
    merged.push(next.event);
    const following = chains[next.chainIndex].events[next.positionInChain + 1];
    if (following) {
      heap.push({
        event: following,
        instantMs: eventInstantMs(following),
        chainIndex: next.chainIndex,
        positionInChain: next.positionInChain + 1,
      });
    }
  }
  return merged;
}

/**
 * A component's `scheduling` events in the deterministic order they replay in,
 * whichever legitimate shape they have. Throws {@link ChainError} for a
 * structurally corrupt set (see {@link partitionScheduling}).
 */
export function orderForReplay(
  events: readonly ReviewEvent[],
  options: ChainReplayOptions = {},
): ReviewEvent[] {
  return orderPartition(partitionScheduling(events, options));
}

/** The already-partitioned events in replay order (one chain needs no merge). */
function orderPartition(partition: ChainPartition): ReviewEvent[] {
  if (partition.chains.length === 0) return [];
  if (partition.chains.length === 1) return partition.chains[0].events;
  return mergeChainsCanonically(partition.chains);
}

export type ChainReplay = {
  /** Final FSRS card, or null when there are no scheduling events. */
  card: SchedulerCard | null;
  /**
   * Distinct stored `local_date_at_event` values of accepted authoritative
   * Good/Easy reviews taken while the card was already in the FSRS Review state
   * AND actually due (a genuine due review — an ahead-of-schedule review does
   * not qualify). Hard never advances; the initial learning review is excluded
   * because the card is not yet in Review. Sorted ascending.
   */
  masteryDates: string[];
  /** Whether any review was a clean success (rating ≠ Again) — gates Learning. */
  hasCleanSuccess: boolean;
  scheduledEventCount: number;
  /** The event replayed LAST — the one a new review extends (see {@link deriveNextLineage}). */
  headEventId: string | null;
  /**
   * The HIGHEST `client_component_revision` in the set, which a new review must
   * exceed. For a `strict` chain that is the head's own revision (unchanged from
   * Phase 7); for a merge union the head is the chronologically last event, whose
   * revision may be lower than another chain's, so the maximum — not the head's
   * value — is what keeps a new revision unique across the whole union.
   */
  headRevision: number;
  /** How the event set is shaped ({@link ChainShape}). */
  shape: ChainShape;
  /**
   * Whether the set contains its own whole history. When false (an anchor-rooted
   * chain whose earlier events were never local — R2-F2) this replay starts from
   * a fresh card partway through a real history and is therefore NOT
   * authoritative: keep the server's card instead of persisting it.
   */
  complete: boolean;
};

/**
 * Replay a component's accepted scheduling events, producing the final card and
 * the distinct qualifying mastery dates. Deterministic: each review is applied
 * at its own immutable event instant, in {@link orderForReplay} order.
 */
export function replayChain(
  events: readonly ReviewEvent[],
  options: ChainReplayOptions = {},
): ChainReplay {
  const partition = partitionScheduling(events, options);
  const ordered = orderPartition(partition);
  if (ordered.length === 0) {
    return {
      card: null,
      masteryDates: [],
      hasCleanSuccess: false,
      scheduledEventCount: 0,
      headEventId: null,
      headRevision: 0,
      shape: partition.shape,
      complete: partition.complete,
    };
  }

  let card = newCard(eventInstantMs(ordered[0]));
  const masteryDates = new Set<string>();
  let hasCleanSuccess = false;

  for (const event of ordered) {
    const instant = eventInstantMs(event);
    // Mastery qualifies only for Good/Easy taken while ALREADY in the Review
    // state AND actually due at review time (a genuine due review) — evaluated
    // BEFORE the rating is applied.
    if (
      card.state === "review" &&
      isDue(card, instant) &&
      (event.rating === "good" || event.rating === "easy")
    ) {
      masteryDates.add(event.localDateAtEvent);
    }
    if (event.rating !== "again") hasCleanSuccess = true;
    card = reviewCard(card, instant, event.rating);
  }

  const head = ordered[ordered.length - 1];
  return {
    card,
    masteryDates: [...masteryDates].sort(),
    hasCleanSuccess,
    scheduledEventCount: ordered.length,
    headEventId: head.eventId,
    headRevision: ordered.reduce(
      (highest, event) => Math.max(highest, event.clientComponentRevision),
      0,
    ),
    shape: partition.shape,
    complete: partition.complete,
  };
}

/**
 * The event a new review must extend: the LAST event in replay order. For a
 * `strict` chain that is the highest-revision event (unchanged from Phase 7);
 * for a merge union it is the chronologically last event across the union, so a
 * new review continues from the learner's most recent actual review rather than
 * from whichever imported chain happened to carry the larger revision number.
 */
export function chainHead(
  events: readonly ReviewEvent[],
  options: ChainReplayOptions = {},
): ReviewEvent | null {
  const ordered = orderForReplay(events, options);
  return ordered.length === 0 ? null : ordered[ordered.length - 1];
}

/**
 * The lineage for the NEXT local event of a component, derived from its current
 * event set. Identical to {@link deriveLineage} for a `strict` chain; for a merge
 * union it parents on the chronological head while taking the revision from the
 * union's MAXIMUM, so the new revision is unique across both merged histories
 * and the server's contiguity check still sees "one past the highest".
 *
 * SERVER PAIRING (phases-17.md §14): the server's own head selection must use
 * this same rule for a merged component, or an event derived here is rejected as
 * a stale branch. `modules/sync/server/ingest.ts` still picks its head by highest
 * revision — correct and equivalent for a `strict` chain, which is all ordinary
 * sync can produce — so the slice that first PERSISTS a union must switch it to
 * this shared rule and prove it with an integration test.
 */
export function deriveNextLineage(
  events: readonly ReviewEvent[],
  ids: { eventId: string; clientSequence: number },
  initialBaseServerRevision = 0,
  options: ChainReplayOptions = {},
): EventLineage {
  const replay = replayChain(events, options);
  const head = events.find((event) => event.eventId === replay.headEventId);
  const lineage = deriveLineage(head ?? null, ids, initialBaseServerRevision);
  return { ...lineage, clientComponentRevision: replay.headRevision + 1 };
}

export type UndoResult = {
  /** The chain without its head event. */
  events: ReviewEvent[];
  /** The removed head event — the caller deletes its `attemptId` too. */
  removedEvent: ReviewEvent;
  /** The card state restored by re-replaying the remaining chain. */
  restoredCard: SchedulerCard | null;
};

/**
 * Undo the last local scheduling event (pre-sync). Returns the chain without
 * its head, the removed event (so the caller deletes the corresponding
 * ATTEMPT — the attempt store is impure, outside this module), and the card
 * restored by re-replaying the remaining chain (single-step).
 */
export function undoLastEvent(
  events: readonly ReviewEvent[],
  options: ChainReplayOptions = {},
): UndoResult {
  const ordered = orderForReplay(events, options);
  if (ordered.length === 0) {
    throw new ChainError("nothing to undo: no scheduling events");
  }
  const removedEvent = ordered[ordered.length - 1];
  const remaining = events.filter(
    (event) => event.eventId !== removedEvent.eventId,
  );
  return {
    events: remaining,
    removedEvent,
    restoredCard: replayChain(remaining, options).card,
  };
}
