/**
 * Phase 17 §12 — splitting a guest snapshot into bounded upload chunks.
 *
 * PURE: no Dexie, no fetch, no clock. Given a snapshot it returns the exact
 * sequence of chunk bodies the upload driver will send, which is what makes
 * resume tractable — chunk `n` is a deterministic function of the snapshot, so a
 * resumed upload that skips to index `n` sends precisely the bytes the first
 * attempt would have sent, and the server's per-item idempotency is never asked
 * to reconcile two different splittings of one history.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING HERE: a scheduling event and the attempt
 * it grades must travel in the SAME chunk. The server derives correctness and
 * rating from the attempt and never trusts the client's claim (§9.3), and it
 * resolves that attempt from the ATTEMPTS IN THE SAME REQUEST — `ingest.ts`
 * builds its `attemptsById` map per call and rejects an event whose attempt is
 * absent as `malformed_item`, a permanent, non-recoverable rejection. So an
 * attempt already stored by an earlier chunk does not help: splitting a pair
 * across two chunks does not delay the event, it DESTROYS it, silently, while
 * every other item succeeds.
 *
 * The planner therefore packs UNITS, not items: each attempt travels with every
 * event that grades against it, and a unit is never split. Attempts no event
 * references (reinforcement-only) are units of one, as are bookmarks, lists and
 * settings.
 *
 * WHY EACH CHUNK IS FILLED GREEDILY. §29 asks for bounded requests, not for the
 * fewest possible; but `GUEST_MERGE_BOUNDS.maxChunks` is finite, so an
 * under-filling planner could refuse a history the bounds allow. A maximal legal
 * snapshot is ~50,550 items whose per-kind caps (500 attempts + 500 events fills
 * one 1,000-item chunk exactly) need ~60 chunks when packed across kinds, and
 * over 100 when each kind is drained before the next is started.
 */
import {
  GUEST_MERGE_BOUNDS,
  SYNC_BOUNDS,
  type GuestMergeDeclaredCounts,
  type WireAttempt,
  type WireBookmark,
  type WireEvent,
  type WireList,
  type WireSetting,
} from "@/modules/sync/protocol";

import type { GuestSnapshot } from "./guest-snapshot";

/** The item payload of one chunk request — everything but the envelope. */
export type GuestMergeChunkBody = {
  attempts: WireAttempt[];
  events: WireEvent[];
  bookmarks: WireBookmark[];
  lists: WireList[];
  settings: WireSetting[];
};

/** Thrown when a snapshot cannot be expressed within `maxChunks`. */
export class GuestMergeChunkOverflowError extends Error {
  constructor(
    readonly chunks: number,
    readonly limit: number,
  ) {
    super(`merge needs ${chunks} chunks, over the limit of ${limit}`);
    this.name = "GuestMergeChunkOverflowError";
  }
}

/** The counts the `begin` stage declares — derived from the snapshot itself. */
export function declaredCountsOf(
  snapshot: GuestSnapshot,
): GuestMergeDeclaredCounts {
  return {
    attempts: snapshot.attempts.length,
    events: snapshot.events.length,
    bookmarks: snapshot.bookmarks.length,
    lists: snapshot.lists.length,
    settings: snapshot.settings.length,
  };
}

/**
 * An indivisible group of items. Almost always one item; an attempt plus the
 * events grading against it when they must not be separated (see the header).
 */
type Unit = Partial<GuestMergeChunkBody>;

function emptyBody(): GuestMergeChunkBody {
  return { attempts: [], events: [], bookmarks: [], lists: [], settings: [] };
}

/** Per-kind ceiling on ONE chunk, as the wire enforces it. */
const PER_CHUNK: Record<keyof GuestMergeChunkBody, number> = {
  attempts: SYNC_BOUNDS.maxAttempts,
  events: SYNC_BOUNDS.maxEvents,
  bookmarks: SYNC_BOUNDS.maxBookmarks,
  lists: SYNC_BOUNDS.maxLists,
  settings: SYNC_BOUNDS.maxSettings,
};

const KINDS = Object.keys(PER_CHUNK) as (keyof GuestMergeChunkBody)[];

function countOf(body: Unit): number {
  return KINDS.reduce((sum, kind) => sum + (body[kind]?.length ?? 0), 0);
}

/** Whether `unit` still fits in `body` under the total and per-kind caps. */
function fits(body: GuestMergeChunkBody, unit: Unit): boolean {
  if (countOf(body) + countOf(unit) > GUEST_MERGE_BOUNDS.maxItemsPerChunk) {
    return false;
  }
  return KINDS.every(
    (kind) => body[kind].length + (unit[kind]?.length ?? 0) <= PER_CHUNK[kind],
  );
}

function append(body: GuestMergeChunkBody, unit: Unit): void {
  for (const kind of KINDS) {
    const items = unit[kind];
    // Each branch pushes into the array of its own kind, so the element types
    // agree; TypeScript cannot follow that through the union of five key
    // literals without a per-kind branch, which is what this table removes.
    if (items?.length) (body[kind] as unknown[]).push(...items);
  }
}

/**
 * Group the snapshot into indivisible units, in send order: attempt+events
 * pairs first (they carry the dependency), then unreferenced attempts, then
 * bookmarks, lists and settings.
 */
function unitsOf(snapshot: GuestSnapshot): Unit[] {
  const eventsByAttempt = new Map<string, WireEvent[]>();
  for (const event of snapshot.events) {
    const group = eventsByAttempt.get(event.attemptId) ?? [];
    group.push(event);
    eventsByAttempt.set(event.attemptId, group);
  }

  const units: Unit[] = [];
  const loose: WireAttempt[] = [];
  for (const attempt of snapshot.attempts) {
    const events = eventsByAttempt.get(attempt.id);
    if (events) {
      units.push({ attempts: [attempt], events });
      eventsByAttempt.delete(attempt.id);
    } else {
      loose.push(attempt);
    }
  }
  // An event whose attempt is not in the snapshot. Collection already drops
  // these (an event without its attempt is ungradeable), so this is unreachable
  // for a snapshot built by `collectGuestSnapshot` — but sending it alone, to be
  // refused and COUNTED as refused, is more honest than dropping it here where
  // no summary would ever mention it.
  for (const orphaned of eventsByAttempt.values()) {
    units.push({ events: orphaned });
  }
  for (const attempt of loose) units.push({ attempts: [attempt] });
  for (const bookmark of snapshot.bookmarks) units.push({ bookmarks: [bookmark] }); // prettier-ignore
  for (const list of snapshot.lists) units.push({ lists: [list] });
  for (const setting of snapshot.settings) units.push({ settings: [setting] });
  return units;
}

/**
 * Split `snapshot` into the chunk bodies to upload, in order.
 *
 * An empty snapshot yields NO chunks — the upload then goes straight from
 * `begin` to `finalize`, which is the honest shape for a merge that carries
 * nothing rather than a chunk asserting emptiness.
 *
 * Throws {@link GuestMergeChunkOverflowError} when the result would exceed
 * `GUEST_MERGE_BOUNDS.maxChunks`. Collection already refuses a snapshot over
 * `GUEST_SNAPSHOT_BOUNDS`, which packs well inside this limit, so reaching it
 * means one of the two ceilings moved without the other — a loud failure is
 * better than an upload the server will refuse mid-flight.
 */
export function planGuestMergeChunks(
  snapshot: GuestSnapshot,
): GuestMergeChunkBody[] {
  const chunks: GuestMergeChunkBody[] = [];
  let current = emptyBody();

  for (const unit of unitsOf(snapshot)) {
    if (!fits(current, unit)) {
      // A unit that fits in no chunk at all would loop forever. It cannot
      // happen — the largest unit is one attempt plus its events, and a
      // component's event count is bounded far below the per-chunk cap — but an
      // infinite loop is the one failure mode a planner must not have.
      if (countOf(current) === 0) {
        throw new GuestMergeChunkOverflowError(
          chunks.length + 1,
          GUEST_MERGE_BOUNDS.maxChunks,
        );
      }
      chunks.push(current);
      current = emptyBody();
    }
    append(current, unit);
  }
  if (countOf(current) > 0) chunks.push(current);

  if (chunks.length > GUEST_MERGE_BOUNDS.maxChunks) {
    throw new GuestMergeChunkOverflowError(
      chunks.length,
      GUEST_MERGE_BOUNDS.maxChunks,
    );
  }
  return chunks;
}
