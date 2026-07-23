# Safwa — Offline & Synchronisation Design

Status: planning baseline (Architecture Plan v4, approved 2026-07-14).
Offline synchronisation is **not simple**; it ships in explicit stages (§9)
and no stage's guarantees are claimed before its tests pass.

## 1. Guest persistence

- All guest state lives in Dexie/IndexedDB (stores in `DATA_MODEL.md` §9):
  cached content releases, study components (natural-key primary keys),
  attempts, the local causal event chain, sessions, bookmarks, lists,
  settings, anonymous profile + `device_id`.
- On first meaningful progress the app requests
  `navigator.storage.persist()` and surfaces a gentle "create an account to
  protect your progress" prompt (dismissible; guests are never blocked).
- `localStorage` holds only trivial UI state; nothing learning-related.

## 2. Content caching and version pinning

- The service worker (Serwist) precaches the app shell; the active learner
  content release is stored in Dexie with its `release_id` and checksum.
- Clients discover the active release via a small pointer (static JSON +
  API mirror). A checksum mismatch ⇒ discard and re-download before study.
- A study **session is pinned to one content version at start** and never
  swaps mid-session; upgrades apply at the next session start.
- Old releases remain valid for sync indefinitely unless explicitly revoked
  (§8) — an event is never rejected merely for referencing an old release.

## 3. Offline authenticated study

Signed-in users study offline exactly like guests: the study engine,
question generator and FSRS run locally against the cached release. Every
attempt records its full deterministic question specification
(`question_instance_id`, `question_seed`, `question_generator_version`,
component key, answer refs, hint state) and event-time timezone metadata, so
the server can later reconstruct and validate the question and preserve the
original local study dates.

**Current status (Phase 15): accounts exist, sync does not yet.** Phase 15
ships identity/auth only (registration, verification, login, sessions,
account settings, account deletion) — the ingestion/replay pipeline this
section describes ships in Phase 16 (Stage A, §10). Until then, a signed-in
user's study progress is **local-only, identical to a guest's**: the
account page says so explicitly ("Study progress stays on this device only
— signing in does not back up or sync it yet"), and account deletion never
touches local Dexie data (there is nothing server-side to reconcile it
against). This is a real, user-visible limitation, not an oversight — do
not imply cross-device sync exists anywhere in the UI before Phase 16 ships
it.

## 4. Mutation queue

- Ordered outbound queue in Dexie; every mutation carries a client-generated
  UUID idempotency key (events use `event_id` itself).
- Flush triggers: app open, `online` event, post-session, periodic while
  active. Background Sync API is used where available but never relied on.
- Retry with exponential backoff + jitter; permanent rejections (validation
  failures) are moved to a dead-letter store with a user-visible, recoverable
  error state — never silently dropped.
- Batch pushes are size-limited; the server responds per-item.

## 5. Causal event graph and conflict resolution

Why not last-write-wins: LWW on FSRS state silently destroys one device's
reviews, double-advances mastery when timestamps skew, and cannot represent
"both reviews really happened". Instead, scheduling review events form a
**causal DAG** and authoritative state is deterministic replay.

**Lineage metadata** (per scheduling event): `base_server_revision` (server
component revision known when the local chain began), `parent_event_id` (the
preceding scheduling event — server-accepted or local unsynced; never a
reinforcement attempt), `client_component_revision` (monotonic per-client
validation aid).

**Sequential vs concurrent:** events on one causal chain (Y's parent is X)
are sequential — both normally affect FSRS even if both carry the same stale
`base_server_revision`. Two events are **concurrent** iff neither is an
ancestor of the other, they branch from the same causal parent/equivalent
authoritative state, and neither's local history includes the other.
Timestamps never establish causality.

**Server ingestion pipeline:**

1. Dedupe by `event_id` (duplicate delivery returns the prior result).
2. Validate structure against the validation manifest (component key, skill,
   shape, eligibility, release) and lineage (`parent_event_id`,
   `client_component_revision`).
3. Compute `occurred_at_canonical` (clamp: ≤ `server_received_at` with ~2 min
   tolerance; ≥ same device's previous accepted event; missing/absurd ⇒
   `server_received_at` + `clock_suspect` flag).
4. Insert into the component's DAG and classify: extends accepted chain ·
   concurrent branch · unknown parent · cycle · invalid revision.
5. Reject cycles and impossible lineage (recoverable errors). Hold
   unknown-parent events as `pending_parent`; reprocess when the parent
   arrives; a per-hold TTL + client chain-resubmission if it never does. (As
   built, Stage A uses `SYNC_BOUNDS.pendingTtlMs` = 30 days — deliberately wider
   than this original ~14-day sketch, to comfortably exceed any legitimate
   Stage-A offline gap before a stricter Stage-B policy tightens it; an expired
   hold is excluded from the per-component live cap and never promoted.)
6. Resolve genuine branch conflicts: **most pessimistic rating wins**
   (Again < Hard < Good < Easy), ties by canonical order. The losing branch's
   initial event **and its scheduling descendants** become `conflict_demoted`
   (they never advance FSRS, mastery days or review counts; their attempts
   remain for analytics). Winning-branch descendants are preserved where
   causally valid.
7. Replay accepted scheduling events in causal (topological) order; bump the
   component `revision`; recompute learner state and mastery-day sets from
   stored `local_date_at_event` values of accepted authoritative events.
8. Respond with reconciled component states + affected event ids
   (accepted / demoted / pending / rejected).

**Client rebase:** on receiving reconciliation, the client replaces its
optimistic FSRS state with the server state, marks local events per the
response, keeps all attempts, and shows a quiet "your schedule was updated
from your other devices" notice when scheduling changed. Undo of an already-
synced event uses a revocation mutation (`status: revoked`) followed by
server replay.

**Legacy fallback:** only for events with no valid `parent_event_id` / no
usable `base_server_revision` / invalid causal metadata: a conservative
10-minute window requiring different device ids, the same component, no
intervening accepted revision, similar session context where available —
logged for monitoring. Modern valid events never use it.

## 6. Same card on two offline devices (walkthrough)

Server has component at revision 4. Device A reviews it twice offline
(events X then Y; Y.parent = X; both base_server_revision = 4). Device B
reviews it once offline (event Z; Z.parent = server head; base = 4).

- A syncs first: X extends the accepted chain (its parent is the server
  head); Y extends X. Both accepted; replay applies X then Y; revision → 6.
- B syncs: Z's parent is the old server head — Z is neither an ancestor nor a
  descendant of X — a genuine branch. Conflict set {X (branch head), Z}: the
  most pessimistic rating wins. If X is Good and Z is Again, **Z wins** and
  becomes scheduling-authoritative; X **and its descendant Y** become
  `conflict_demoted`; replay applies Z only; both devices rebase; A's attempts
  remain visible in history/analytics; mastery days are recomputed from
  accepted events only.

(The same mechanics handle three devices, longer chains and guest merges.)

## 7. Guest→account merge

Merge **is** sync: guest events/attempts are submitted through the identical
ingestion pipeline with their original ids, lineage and event-time dates.
Deterministic and idempotent (`guest_imports` records the import; replaying
the same submission is a no-op). No "take the strongest state" shortcut —
merged FSRS state is whatever replay of the accepted union produces.
Bookmarks/lists union; account settings win, guest fills gaps.

## 8. Content-version changes and long-offline recovery

- Validation + assessment manifests are retained **indefinitely**; release
  status is `active | supported | revoked`, separate from client protocol
  support (`minimum_supported_client_version`,
  `minimum_supported_event_schema`). An old content release can stay
  `supported` even when an old client binary must upgrade before syncing.
- Long-offline user with a supported release: events validate against the
  retained manifests and ingest through the normal causal pipeline; cached
  content upgrades after the active session; **no valid historical progress
  is discarded**.
- Revoked release (dangerous/corrupt content, incompatible event schema,
  security issue, unvalidatable attempts): scheduling events referencing it
  are not applied; local attempts are preserved for export/support
  diagnostics; the user is told to refresh content; local study history is
  never silently deleted.
- Cached-release / server mismatch: the client is told the current release id
  on every sync; upgrade is downloaded in the background and applied at next
  session start.

## 9. Failure scenarios

| Scenario                   | Behaviour                                                                 |
| -------------------------- | ------------------------------------------------------------------------- |
| Duplicate event delivery   | idempotent no-op (unique `event_id`)                                      |
| Parent never arrives       | `pending_parent` TTL → recoverable error; client resubmits chain          |
| Cyclic/impossible lineage  | rejected, recoverable; queue not blocked                                  |
| Clock skew                 | canonical clamping; never converts sequential→concurrent                  |
| Storage evicted (guest)    | mitigated by `storage.persist()` + register prompts; risk documented      |
| Sync rejected (validation) | dead-letter + user-visible recoverable state; audit log server-side       |
| Checksum mismatch          | re-download release before study                                          |
| Server unreachable         | study continues locally; queue accumulates; status UI shows pending count |

Sync status UI: unobtrusive indicator (synced / pending N / offline /
attention needed), detail view listing recoverable issues.

## 10. Staged rollout (do not skip stages)

| Stage                           | Phase | Guarantee added                                                                       |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| A — Online sync                 | 16–17 | authenticated push/pull, server validation + replay, guest merge                      |
| B — Offline queue               | 18    | installable PWA, offline study, queued mutations, reconnection flush                  |
| C — Multi-device reconciliation | 19    | concurrent branch detection, demotion, rebase — full offline multi-device correctness |

Stage A assumes connectivity for account features (guests are always fully
local). Offline correctness across devices is only claimed after Stage C's
test suite (including cross-browser and iOS PWA verification) passes.

## As built — Stage A (Phase 16)

Stage A (server-authoritative learning-state sync) is implemented. Delivered:

- **Server** (`modules/sync/server/*`, `app/api/sync/{push,pull}`): the wire
  protocol + Zod schemas; the `SYNC_ENABLED` kill-switch; the authenticated,
  email-verified request guard (503-before-auth); server-authoritative
  objective grading (client `is_correct`/`rating` never trusted) + flashcard
  validation; canonical event time; causal-lineage classification with a GLOBAL
  parent lookup that rejects cross-user / cross-component parents rather than
  holding them; deterministic FSRS replay; the account-wide monotonic cursor
  with gap-free pagination; idempotency (payload hashing + `payload_conflict`);
  per-component advisory-locked transactional ingest with per-component error
  isolation; independent per-event **and per-attempt** validation (a batch never
  grades later items using the first item's identity); reinforcement-only
  attempt ingestion (history, never advances FSRS); the bounded cross-batch
  pending-parent reprocessor with a per-component **live-pending cap**
  (`SYNC_BOUNDS.maxPendingPerComponent`) + a per-hold **expiry**
  (`pendingExpiresAt`; expired holds are excluded from the cap and never
  promoted); revocation/undo; and allow-listed audit-log redaction.
- **Client** (`modules/sync/client/*`, `components/sync/*`): the typed API
  client (request+response validated against the wire schemas), the pure status
  state machine, local unsynced scheduling selection **account-scoped by the
  linked attempt's owner** (a guest's / another account's rows are never
  uploaded, so login never merges), the Dexie **`mutation_queue` sync outbox**
  for the non-scheduling categories (bookmark / list / setting upserts+deletes,
  post-sync-undo revocations, and reinforcement-only attempts) with coalescing,
  per-item ack, recoverable-retry and permanent dead-letter, push-result apply,
  pull reconcile (including the settings server↔local key/shape round-trip
  mapping), the bounded push-batch builder (per-kind + total wire caps with room
  reserved so small latency-sensitive mutations are never starved), the
  coalescing orchestrator (single-flight, per-request timeout, logout guard),
  **durable post-sync undo** (a never-sent event is deleted locally; a
  server-accepted event is revoked via a queued revocation + replay while its
  history is kept; a still-pending event defers), the framework-light trigger
  controller, the `SyncProvider` (bootstrap / periodic-while-visible /
  visibility / online / session-end / manual-retry triggers), the §20 status
  indicator (pending count includes the queued mutations), and the shared-device
  logout wipe (which clears the `mutation_queue` with the other account-scoped
  stores).

**Deferred to later stages (as designed):** durable per-trigger offline retry
with exponential backoff, full multi-device concurrent conflict resolution /
pessimistic-winner demotion, a scheduled purge/dead-letter job for EXPIRED
pending-parent rows (the per-component cap + TTL that bound the _live_ backlog
are built; a background purge of the expired rows themselves is Stage B+, see
RISK_REGISTER #21), the guest→account merge (Phase 17), and a full authenticated
multi-context sync E2E — all Phase 17/18/19 (Stage A completion + Stage B+). The
indicator deliberately does not claim offline durability or multi-device
conflict resolution.
