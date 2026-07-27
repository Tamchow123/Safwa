/**
 * Phase 17 §12 — the GUEST snapshot: what a guest's local learner state looks
 * like on the wire, plus the stable hash that identifies it.
 *
 * Nothing here uploads anything. Building a snapshot is a pure read of the
 * guest-owned Dexie rows, which is what makes §9.1's consent model possible:
 * the merge UI can show honest pre-merge counts, and the user can still decline
 * without a single byte having left the device.
 *
 * WHAT IS SELECTED (§12): guest attempts, guest scheduling events, guest
 * bookmarks, guest custom lists with their canonical membership, the
 * allow-listed guest settings, and the device id. WHAT IS NOT, deliberately:
 * content artifacts and the cached release (immutable, already on the server),
 * auth/session data, the derived `study_components` projections (the server
 * rebuilds those from the events — a client projection is never authoritative),
 * daily-activity roll-ups (likewise derived), the mutation queue (an account's
 * outbound work, never a guest's), and any setting outside the server
 * allow-list. Selection reads ONLY guest-owned rows, so an account's rows
 * cannot be swept into a merge even if one is signed in on the same device.
 *
 * Browser-only (Dexie); the mapping, ordering and hashing are pure.
 */
import type { SafwaDb } from "@/modules/content/db";
import { GUEST_OWNER_KEY } from "@/modules/content/owner-key";
import { readOwnedRows } from "@/modules/content/owner-scope";
import { sha256HexBrowser } from "@/modules/content/sha256-browser";
import {
  canonicalJson,
  GUEST_MERGE_BOUNDS,
  wireBookmarkSchema,
  wireListSchema,
  type WireAttempt,
  type WireBookmark,
  type WireEvent,
  type WireList,
  type WireSetting,
} from "@/modules/sync/protocol";

import { toWireAttempt, toWireEvent } from "./local-selection";
import { mapLocalSettingToWire } from "./settings-sync";

/**
 * Hard in-memory ceiling on one snapshot (§29 "do not load an unlimited
 * history into browser memory"). A guest reaching this has studied for years
 * without an account; rather than silently truncate their history — which would
 * present a partial merge as a complete one — collection fails loudly and the
 * UI reports it. Well above the per-request `SYNC_BOUNDS` caps, which bound a
 * single CHUNK; a snapshot larger than one chunk is normal and expected.
 */
export const GUEST_SNAPSHOT_BOUNDS = {
  maxEvents: 20_000,
  maxAttempts: 20_000,
  maxBookmarks: 10_000,
  // Derived, not repeated: the wire is the authority on how many lists ONE
  // import may carry, so a client ceiling that merely equalled it by convention
  // could drift and refuse to collect a history the server would have accepted.
  maxLists: GUEST_MERGE_BOUNDS.maxLists,
} as const;

/** The kinds `GUEST_SNAPSHOT_BOUNDS` caps, named as the snapshot names them. */
export type GuestSnapshotBoundedKind = "events" | "attempts" | "bookmarks" | "lists"; // prettier-ignore

const BOUND_OF: Record<GuestSnapshotBoundedKind, number> = {
  events: GUEST_SNAPSHOT_BOUNDS.maxEvents,
  attempts: GUEST_SNAPSHOT_BOUNDS.maxAttempts,
  bookmarks: GUEST_SNAPSHOT_BOUNDS.maxBookmarks,
  lists: GUEST_SNAPSHOT_BOUNDS.maxLists,
};

/** Raised when a guest's local dataset exceeds `GUEST_SNAPSHOT_BOUNDS`. */
export class GuestSnapshotTooLargeError extends Error {
  constructor(
    readonly kind: GuestSnapshotBoundedKind,
    readonly count: number,
    readonly limit: number,
  ) {
    super(`guest snapshot exceeds the ${kind} limit (${count} > ${limit})`);
    this.name = "GuestSnapshotTooLargeError";
  }
}

/**
 * Cheap counts of what a guest has locally — enough to decide whether to offer
 * the merge at all and to render the pre-merge summary, without materialising
 * the snapshot. Every count is an INDEXED owner-scoped count.
 */
export type GuestDataSummary = {
  /** Distinct study components the guest has scheduling state for. */
  components: number;
  events: number;
  attempts: number;
  bookmarks: number;
  lists: number;
};

/**
 * Does this guest have anything worth merging? (§19 — the consent prompt is
 * shown only for MEANINGFUL data; an empty or settings-only guest must not be
 * interrupted with a decision that has no content behind it.) Settings alone do
 * not qualify: they are device preferences that the account's own settings win
 * over anyway (§18), so a prompt about them would be noise.
 */
export function isMeaningfulGuestData(summary: GuestDataSummary): boolean {
  return (
    summary.events > 0 ||
    summary.attempts > 0 ||
    summary.bookmarks > 0 ||
    summary.lists > 0
  );
}

/** Owner-scoped counts of the guest's local learner state. */
export async function summarizeGuestData(
  db: SafwaDb,
): Promise<GuestDataSummary> {
  const [components, events, attempts, bookmarks, lists] = await Promise.all([
    db.studyComponents.where("ownerKey").equals(GUEST_OWNER_KEY).count(),
    db.reviewEvents.where("ownerKey").equals(GUEST_OWNER_KEY).count(),
    db.studyAttempts.where("ownerKey").equals(GUEST_OWNER_KEY).count(),
    db.bookmarks.where("ownerKey").equals(GUEST_OWNER_KEY).count(),
    db.lists.where("ownerKey").equals(GUEST_OWNER_KEY).count(),
  ]);
  return { components, events, attempts, bookmarks, lists };
}

/**
 * Records that were present locally but are not transferable, counted per kind
 * so the summary UI can say so instead of quietly reporting a smaller total
 * than the pre-merge prompt promised (§21 — an honest summary).
 *
 * A record is skipped only when it cannot legally cross the wire: it fails the
 * shared wire schema, or (for an event) its linked attempt is missing or
 * invalid, which makes the event ungradeable server-side — the server derives
 * correctness from the attempt and never trusts a client claim (§9.3).
 */
export type GuestSnapshotSkips = {
  events: number;
  attempts: number;
  bookmarks: number;
  lists: number;
  settings: number;
};

/**
 * A coherent, deterministically ordered guest snapshot. Ordering is part of the
 * contract: the snapshot HASH is taken over this exact structure, so two
 * collections of unchanged data must produce byte-identical canonical JSON
 * (§12 — "stable across retries of the same guest snapshot").
 */
export type GuestSnapshot = {
  /** Snapshot shape version — part of the hash so a future shape cannot collide. */
  version: 1;
  /** The anonymous device that produced this history; absent if never minted. */
  deviceId: string | null;
  /** Chronological (event id is a UUIDv7, so id order IS time order). */
  events: WireEvent[];
  /** Ordered by attempt id. */
  attempts: WireAttempt[];
  /** Ordered by entry id. */
  bookmarks: WireBookmark[];
  /** Ordered by list id, membership in stored order. */
  lists: WireList[];
  /** Allow-listed settings only, ordered by key. */
  settings: WireSetting[];
  /** Untransferable rows, per kind. NOT part of the hash (see `guestSnapshotHash`). */
  skipped: GuestSnapshotSkips;
};

/** Total transferable items — what the chunked upload (§12) has to get through. */
export function guestSnapshotItemCount(snapshot: GuestSnapshot): number {
  return (
    snapshot.events.length +
    snapshot.attempts.length +
    snapshot.bookmarks.length +
    snapshot.lists.length +
    snapshot.settings.length
  );
}

function assertWithinBounds(
  kind: GuestSnapshotBoundedKind,
  count: number,
): void {
  const limit = BOUND_OF[kind];
  if (count > limit) throw new GuestSnapshotTooLargeError(kind, count, limit);
}

/**
 * Build the guest snapshot. Reads only guest-owned rows, validates every record
 * against the shared wire schema, and drops (counting) whatever cannot legally
 * be sent.
 *
 * The whole collection runs in ONE read transaction, so every store is observed
 * at the same point in time. Two things depend on that. The size ceiling is
 * decided from counts taken before any row is materialised, and outside a
 * transaction a guest studying in another tab could push the store past the
 * limit that was just checked. And the snapshot HASH must describe a coherent
 * state: attempts read a moment before the events that reference them would give
 * a snapshot no single instant of the database ever contained.
 *
 * ACCEPTED TRADE-OFF: the scope covers `study_attempts`, `review_events` and
 * `study_components`, which the study loop writes to on every answered question,
 * and IndexedDB makes a readwrite transaction wait for an open transaction whose
 * scope it overlaps. So a collection near the ceiling can briefly stall a
 * concurrent answer submission. That is the price of a consistent read, and it
 * is worth paying here: this runs once, for an explicit user-initiated merge, on
 * a screen the learner is not studying from, and every cheaper alternative
 * (per-store transactions, a freshness token) reintroduces the very race the
 * transaction exists to close. Revisit only if a large-guest benchmark shows a
 * stall a learner would actually notice.
 *
 * Throws `GuestSnapshotTooLargeError` when the guest's dataset exceeds
 * `GUEST_SNAPSHOT_BOUNDS`.
 */
export async function collectGuestSnapshot(
  db: SafwaDb,
): Promise<GuestSnapshot> {
  return db.transaction(
    "r",
    [
      db.studyComponents,
      db.studyAttempts,
      db.reviewEvents,
      db.bookmarks,
      db.lists,
      db.settings,
      db.profile,
    ],
    () => collectGuestSnapshotInTransaction(db),
  );
}

async function collectGuestSnapshotInTransaction(
  db: SafwaDb,
): Promise<GuestSnapshot> {
  const skipped: GuestSnapshotSkips = {
    events: 0,
    attempts: 0,
    bookmarks: 0,
    lists: 0,
    settings: 0,
  };

  // Count first, materialise second: an oversized history must be refused
  // BEFORE its rows are pulled into memory, which is the whole point of the
  // ceiling (§29). Counts run off the indexed `ownerKey` and never load a row,
  // and the enclosing read transaction makes them binding on what follows.
  const [summary, deviceProfile] = await Promise.all([
    summarizeGuestData(db),
    db.profile.get("device"),
  ]);
  assertWithinBounds("events", summary.events);
  assertWithinBounds("attempts", summary.attempts);
  assertWithinBounds("bookmarks", summary.bookmarks);
  assertWithinBounds("lists", summary.lists);

  // --- attempts ------------------------------------------------------------
  // Loaded first and indexed by id: an event is only sendable together with the
  // attempt the server regrades it from.
  const storedAttempts = await db.studyAttempts
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  const wireAttemptById = new Map<string, WireAttempt>();
  for (const stored of storedAttempts) {
    const wire = stored.attempt ? toWireAttempt(stored.attempt) : null;
    if (!wire) {
      skipped.attempts += 1;
      continue;
    }
    wireAttemptById.set(wire.id, wire);
  }

  // --- scheduling events ---------------------------------------------------
  const storedEvents = await db.reviewEvents
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  const events: WireEvent[] = [];
  const includedAttempts = new Set<string>();
  for (const record of storedEvents) {
    const wire = toWireEvent(record);
    if (!wire || !wireAttemptById.has(wire.attemptId)) {
      skipped.events += 1;
      continue;
    }
    events.push(wire);
    includedAttempts.add(wire.attemptId);
  }
  events.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));

  // Reinforcement attempts carry no scheduling event and are still part of the
  // guest's history, so EVERY valid guest attempt travels — not only the ones an
  // event points at. `includedAttempts` exists to prove the pairing above held.
  const attempts = [...wireAttemptById.values()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  // --- bookmarks -----------------------------------------------------------
  const bookmarks: WireBookmark[] = [];
  for (const row of await readOwnedRows(db.bookmarks, null)) {
    const parsed = wireBookmarkSchema.safeParse({
      entryId: row.entryId,
      createdAt: row.createdAt,
      deleted: false,
    });
    if (parsed.success) bookmarks.push(parsed.data);
    else skipped.bookmarks += 1;
  }
  bookmarks.sort((a, b) => a.entryId - b.entryId);

  // --- custom lists --------------------------------------------------------
  const lists: WireList[] = [];
  for (const row of await readOwnedRows(db.lists, null)) {
    const parsed = wireListSchema.safeParse({
      id: row.id,
      name: row.name,
      entryIds: row.entryIds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deleted: false,
    });
    if (parsed.success) lists.push(parsed.data);
    else skipped.lists += 1;
  }
  lists.sort((a, b) => (a.id < b.id ? -1 : 1));

  // --- settings ------------------------------------------------------------
  // `mapLocalSettingToWire` IS the allow-list gate (§12 "no arbitrary settings
  // outside the existing allow-list"): a non-syncable or malformed local key
  // maps to nothing. One local key can expand to several server keys (the
  // session-defaults blob), and a key reached from two local rows keeps the
  // NEWEST write.
  const wireSettingByKey = new Map<string, WireSetting>();
  for (const row of await readOwnedRows(db.settings, null)) {
    const mapped = mapLocalSettingToWire(row.key, row.value, row.updatedAt);
    if (mapped.length === 0) {
      skipped.settings += 1;
      continue;
    }
    for (const setting of mapped) {
      const existing = wireSettingByKey.get(setting.key);
      if (!existing || existing.updatedAt <= setting.updatedAt) {
        wireSettingByKey.set(setting.key, setting);
      }
    }
  }
  const settings = [...wireSettingByKey.values()].sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );

  return {
    version: 1,
    deviceId: deviceProfile?.deviceId ?? null,
    events,
    attempts,
    bookmarks,
    lists,
    settings,
    skipped,
  };
}

/**
 * The stable canonical hash identifying this snapshot's CONTENT (§12 — the
 * import key is "tied to a stable canonical snapshot hash"). The server stores
 * it beside the import key so resubmitting the same key with materially
 * different data is a safe payload conflict rather than a silent partial merge
 * (§15).
 *
 * `skipped` is excluded on purpose: it counts what is NOT being sent, so
 * including it would let a change with no effect on the uploaded payload
 * invalidate an in-flight import. Everything that DOES travel is included, in
 * the deterministic order `collectGuestSnapshot` fixed, through the same
 * canonical JSON the server hashes with.
 */
export async function guestSnapshotHash(
  snapshot: GuestSnapshot,
): Promise<string> {
  // Built field by field rather than by spreading and deleting: the hash is an
  // integrity mechanism, so what goes into it is stated explicitly and a field
  // added to `GuestSnapshot` later cannot slip in unconsidered.
  return sha256HexBrowser(
    canonicalJson({
      version: snapshot.version,
      deviceId: snapshot.deviceId,
      events: snapshot.events,
      attempts: snapshot.attempts,
      bookmarks: snapshot.bookmarks,
      lists: snapshot.lists,
      settings: snapshot.settings,
    }),
  );
}
