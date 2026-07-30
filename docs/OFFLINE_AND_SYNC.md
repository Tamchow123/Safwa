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

**Merge-specific union replay.** Uniting two histories for one component
produces a DAG with two roots — the account's chain and the guest's, neither
descended from the other — which is exactly what a corrupted chain looks like.
Two stages keep those apart, and they are not the same check twice:

- **Admission** decides. An arriving event reaches the union-permitting
  classifier (`classifyMergeLineage`, a separate entry point from ordinary
  sync's, requiring a brand-sealed context) only if it carries its own
  `imported_from_guest_import_id`, which only the merge coordinator stamps.
  Everywhere else a second root is still a stale branch and still refused.
- **Replay** tolerates the resulting shape on `study_components.merged_at`
  alone — a durable record that admission already happened for this component.
  It does not re-verify per-event provenance, so it is **not** a second line of
  defence; the defence is at admission (`docs/DATA_MODEL.md` §4.1, ADR-009).

**This is not §5's conflict resolution.** The merge unites **two identities'**
histories on one device, once, with consent. Phase 19 reconciles **one
identity's** history diverging across devices, continuously and without asking.
The multi-root exemption above belongs to the merge and must not be reused by a
conflict resolver: two devices disagreeing about one learner's history is a
disagreement to settle, not two learners' work to combine.

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
  state machine, local unsynced scheduling selection **owner-scoped on the
  event's own `userId`** via the indexed `[userId+syncStatus]` slice (a guest's
  / another account's rows are never uploaded, so login never merges — and no
  scan cap is needed, so a foreign backlog can neither inflate nor starve this
  account's pending count), the Dexie **`mutation_queue` sync outbox**
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
  indicator (pending count includes the queued mutations; a permanent
  **dead-letter** forces the honest `attention` state so a silently-failed change
  can never read as "Synced"), the localStorage-mirror adoption for pulled
  preferences (theme / Arabic font scale, so a second context actually displays
  the synced value instead of a stale pre-paint mirror), and the shared-device
  logout wipe (which clears the `mutation_queue` with the other account-scoped
  stores).
- **Sign-out wipes this device's local learner state — including a guest's.**
  The wipe is what makes a shared device safe **when it happens** (the next
  account can never read the previous one's bookmarks, lists, review history,
  FSRS cards or settings), and since v6 a guest's rows live in the same physical
  stores, so they go too.

  > **Qualified by Phase 18.** "Sign-out makes a shared device safe" is precise
  > about the wipe and silent about the case where no sign-out happens. Phase 18
  > adds a durable last-known-owner memory with **no TTL**, forgotten only by the
  > three triggers in `phases-18.md` §2.1 — a session that classifies as
  > **guest**, an explicit **sign-out**, and **account deletion**. Closing the tab
  > is not one of them, and neither is a different account signing in: that
  > overwrites the memory rather than clearing it, which is the same outcome for
  > this purpose only because the new account is then the one remembered. So a learner who closes the tab without signing out leaves a device
  > whose next **offline** visitor resolves to their account, and that visitor's
  > study is attributed to them. This is confidentiality-preserving in one
  > direction only: the wipe still removes the old rows, so nobody reads anyone
  > else's history — but new writes can land under the wrong owner. Risk 30's
  > sibling, risk 28, records why that trade was taken (the alternative loses a
  > signed-in learner's work outright) and the Phase 18 section below states it
  > among the things this design does not guarantee.
  > This is a deliberate trade-off of guest-data continuity for shared-device
  > confidentiality, pinned by `logout.test.ts` and E2E §60.9, and it supersedes
  > the earlier Phase-15 expectation that guest data survives login/logout.
  > Per-identity coexistence across a sign-out is Phase-17 merge work.

- **Local owner scoping** (Dexie schema **v6**, DATA_MODEL §9.1): the private
  learner-state stores carry a `userId` owner (`null` = guest) with owner-scoped
  indexes, so a signed-in account never reads, extends or overwrites a guest's
  (or another account's) rows sharing a natural key during the coexistence
  window before the sign-out wipe. Scoping covers collections, settings,
  scheduling selection and chain reads, the dashboard/progress/**weakness
  analytics**, and **"export my data"**. The owner comes from the AUTH session
  (never `sync_state`, which is only populated after the first pull) and is
  resolved at ACTION time for writes, so a write issued before the session
  resolves is not mis-stamped as a guest's. Because v6 left primary keys
  unchanged, `userId` scopes reads but is not part of row identity: a second
  identity writing the same natural key REPLACES the first identity's row —
  accepted for Stage A (local-only state has no cross-identity durability
  guarantee and sign-out wipes these stores anyway); per-identity coexistence
  needs composite primary keys and is left to the Phase-17 merge.
- **Lineage anchor**: the pull response carries each component's authoritative
  accepted chain head (`headEventId` + `headClientRevision`), stored locally on
  the component. A device with no local events for that component (fresh
  bootstrap, or post-sign-out-wipe) parents its next review onto the anchor so
  it EXTENDS the server chain rather than rooting a branch the server would
  reject as a stale-branch conflict. Such an anchor-managed component stays
  server-authoritative: its card advances on the next pull rather than by a
  local replay the device lacks the full chain for.

**Deferred to later stages (as designed):** durable per-trigger offline retry
with exponential backoff, full multi-device concurrent conflict resolution /
pessimistic-winner demotion, a scheduled purge/dead-letter job for EXPIRED
pending-parent rows (the per-component cap + TTL that bound the _live_ backlog
are built; a background purge of the expired rows themselves is Stage B+, see
RISK_REGISTER #21), the guest→account merge (Phase 17), and a full authenticated
multi-context sync E2E — all Phase 17/18/19 (Stage A completion + Stage B+). The
indicator deliberately does not claim offline durability or multi-device
conflict resolution.

## As built — the guest→account merge (Phase 17) 🏁 Core MVP

Implemented, and with it the **Core MVP is complete**. §7 states the model;
this records what exists and what still does not.

- **Server** (`modules/sync/server/guest-merge.ts`, `app/api/sync/guest-merge`):
  one authenticated, email-verified, `SYNC_ENABLED`-gated endpoint, behind the
  same 503-before-auth guard as push/pull. Competing imports for an account are
  serialised by an advisory lock. The snapshot goes through the **same**
  ingestion pipeline as push — the same grading, canonical time, lineage
  classification and replay — never a parallel merge-only version. The
  coordinator holds no state between chunks that it does not read back from the
  database, so an interrupted import resumes from what is durable rather than
  from what a process remembered.
- **Idempotency**: the import is recorded against a client-minted key. The same
  snapshot resubmitted under that key is a no-op; a _different_ snapshot under
  the same key is refused with a reason, rather than half-applied. Cross-account
  reuse of a key is refused outright.
- **Provenance and replay**: components that gained an imported history are
  stamped `merged_at` + `merged_from_guest_import_id`, admitted events with
  `imported_from_guest_import_id`, and replay's multi-root rule is conditional
  on both (§7, DATA_MODEL §4.1, ADR-009).
- **Boundedness**: per-kind and total wire caps as push has; a snapshot larger
  than one request is chunked, with an attempt and every event grading against
  it kept in the same chunk because ingest resolves that relationship within a
  request. A declared-totals check refuses a snapshot that claims one size and
  sends another. No transaction is held open across a network request.
- **Client** (`modules/sync/client/guest-merge-*.ts`,
  `components/sync/guest-merge-*`): a twelve-state machine, a coalescing
  single-flight runner, one dialog for consent → progress → summary, and a
  Settings entry point for a deferred offer and for a retry (distinct actions:
  a retry is not a fresh consent). Every learner-facing string comes from a
  pure, tested copy module, which is what makes "no raw internal identifiers"
  checkable.
- **Local finalisation**: the guest's source rows are dropped and the device's
  remaining state re-keyed to the account in **one** Dexie transaction, and only
  after the account's copy is durable. Schema v7 made that safe by putting the
  owner in the primary key (DATA_MODEL §9.2).
- **Consent**: nothing is uploaded before it. Signing in is not agreement, the
  prompt states what will move before asking, and "Not now" uploads nothing,
  deletes nothing and leaves the offer available.
- **Proved end to end**, including the authenticated multi-context second-device
  journey that Stage A deferred (`e2e/guest-merge.spec.ts` §26.1) — that
  deferral is now discharged.

**Still deferred, as designed:** durable offline retry and the PWA (Phase 18);
full concurrent multi-device conflict resolution and pessimistic-winner
demotion (Phase 19); the background purge of expired pending-parent rows
(RISK_REGISTER #21). A learner who requests deletion on one device and confirms
it on another leaves the first device's rows until that device next signs out —
recorded rather than papered over (DATA_MODEL §9.2).

## As built — offline study and the PWA (Phase 18) 🏁 Offline-capable Beta

This is the stage §10 calls "offline queue", and the milestone it delivers is a
learner who can study with no network and lose nothing. What follows is what
shipped, and — the longer half — what it does not claim.

### The offline identity contract

The feature this phase set out to ship would have shipped a silent data-loss bug
with it, so the bug was fixed first (`phases-18.md` §2).

On an offline cold boot, Better Auth's session fetch **rejects** rather than
staying in flight. `isPending` therefore goes false with no data — a state
indistinguishable, to a naive reader, from "resolved: this is a guest". Code that
read it that way stamped every row the learner produced with
`ownerKey: "guest"`, and the sync client only ever selects account-owned rows for
upload. The learner sees an ordinary session, studies, reconnects, and their work
never leaves the device. No server-side probe can see it: the rows never arrive.

So the session has **three** answers, not two
(`modules/auth/session-identity.ts`):

| Answer               | When                                                  | Owner used              |
| -------------------- | ----------------------------------------------------- | ----------------------- |
| `account`            | the session resolved                                  | `account:<id>`          |
| `guest`              | the session resolved to nobody                        | `guest`                 |
| `unresolved-offline` | the fetch failed and this device remembers an account | that remembered account |

The memory (`modules/auth/last-known-owner.ts`) is durable, carries **no clock**,
and is forgotten by exactly three triggers (§2.1), each an identity change the app
already observes:

| Trigger                              | Wired in                                         |
| ------------------------------------ | ------------------------------------------------ |
| a session that classifies as `guest` | `components/sync/use-local-owner.ts`             |
| an explicit sign-out                 | `components/account/sign-out-action.ts`          |
| account deletion                     | `components/account/deleted-account-cleanup.tsx` |

Account deletion is in that list for a reason a clock could not serve: delete the
account, re-register, and go offline before the new account has completed one
successful session check, and the memory would resolve to the **old, deleted**
account id — stamping fresh reviews with a dead owner key. The id is wrong
immediately rather than eventually, so only an event can fix it.

A different account signing in is **not** a forget trigger; it overwrites the
memory (`rememberLastKnownOwner`), which reaches the same place by a different
operation. It is what turns "we cannot tell" into "we know who this is" without
asking the network.

**The regression test is client-side and it is the phase's most important
assertion**: `e2e/offline.spec.ts` cold-boots a new page with the network off,
studies, and asserts through the IndexedDB probe that every new `review_events`
row carries `account:<id>` for the real account id read from Postgres — with no
guest-owned row among them. It answers two questions, not one, because the owner
is resolved per write and a late-settling resolution can get the first write
right and later ones wrong.

### What is NOT guaranteed

- **A device whose storage refuses to forget can keep the memory.**
  `forgetLastKnownOwner()` deletes, reads back to confirm, and neutralises the
  value with a write when the delete returned normally but the value survived —
  three operations, because a storage that silently ignores one may still honour
  another. A storage that refuses everything, or accepts and honours nothing, or
  whose reads throw, defeats all three. The only remaining backstop is the hooks'
  forget on the next `guest` classification, **and that needs a render**: a
  learner who signs out and immediately closes the tab on such a device leaves the
  memory behind. `phases-18.md` §2.1 records this as the phase's residual gap.
- **A shared device, offline, with no sign-out, attributes to the previous
  learner.** The memory has no TTL and closing the tab is not a forget trigger.
  Learner A closes the tab; learner B opens the app offline; B's study lands
  under A's account. Taken deliberately as the lesser harm — the alternative is
  the defect above, which loses a signed-in learner's work irrecoverably — and
  recorded as risk 28. It needs no network **and** no sign-out **and** a second
  person on the same device.
- **iOS offline behaviour is not proved by any automated check.** Playwright's
  WebKit cannot emulate an offline navigation at all (measured;
  `phases-18.md` §8.1). WebKit does prove the worker registers and controls the
  page, that `install` precaches `/~offline`, that browsing fills the document,
  build-asset and content-pointer caches, and the installability criteria — every
  part of the mechanism except serving a navigation with the network off. That
  last step rests on **H4**, a real install on a real iPhone in airplane mode.
  A green CI run does not say "offline works on iPhone". Risk 29.
- **The service-worker cache rules are not what makes content load offline.**
  `modules/content/load.ts` already falls back on every failure path to a
  re-verified release read straight out of Dexie, and did so before this phase.
  What the rules add is a latency bound (a 3s `NetworkFirst` timeout on the
  pointer, which otherwise has no `AbortSignal` and can hang on a degraded
  connection) and a second independent layer. This matters for debugging: a
  broken cache rule degrades latency and redundancy, it does not make the app
  offline-hostile — **start at `load.ts`, not at the worker** (`phases-18.md`
  §7.1).
- **A worker outlives its deploy.** Redeploying an older build removes nothing;
  the rollback is `NEXT_PUBLIC_SW_ENABLED=false` plus a rebuild
  (`DEPLOYMENT.md` §8a, risk 30). A device that never loads the app again keeps
  its worker.
- **Multi-device conflict resolution is still Phase 19.** Two devices studying
  the same card offline still resolve by Stage A's rules; the pessimistic-winner
  demotion of §6 is not implemented. Acquiring a second study device is the
  recorded condition that reopens Phase 19.
- **Background Sync is not used.** The queue flushes on app-open, on `online`,
  and on the existing `SyncProvider` triggers — the API is not uniformly
  available and a queue that only drains when the API happens to exist is worse
  than one that always drains on a predictable event.

### What sign-out and the caches do

`/api/**` is `NetworkOnly`, so no authenticated response is ever stored. Two
caches can hold account-specific markup — documents and RSC payloads, both
server-rendered — and those two are what a sign-out clears
(`OWNER_SENSITIVE_CACHE_NAMES`). The app shell, build assets and downloaded
vocabulary are deliberately **kept**, so the next learner on the device is not
made to re-download the app; none of them is learner-specific. This is the Cache
Storage counterpart to the owner-keyed Dexie sweep, and it is coarse on purpose:
a cached document has no owner key to filter on, so the only honest answer is to
drop the lot and let the next session refill it.
