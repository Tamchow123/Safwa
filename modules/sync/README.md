# modules/sync

Synchronisation logic (Phases 16–19): the outbound mutation queue, event
push/pull, client rebase handling and sync-status state. The server-side
ingestion pipeline shares validation logic with this module — see
`docs/OFFLINE_AND_SYNC.md`.

**What is deliberately NOT here (Phase 18.1).** Rate limiting and the
same-origin assertion live in `modules/http`, not in `sync/server`, even
though the sync routes are their heaviest users. They were briefly here and
the phase council was right to object: `app/api/account/settings` consumes
both, and a reader trusting this file's stated scope would not expect
account settings to break when they refactored sync. `sync/server/auth-guard.ts`
consumes `modules/http`; it does not own it, because it also enforces the
`SYNC_ENABLED` kill switch and the email-verification rule, which are sync's
own policy.

## Layout

- `protocol/` — **pure, isomorphic** wire contract (Zod schemas, reason/status
  enums, bounds, protocol version). Imported by both the browser client and the
  Node server. Must never import React, Dexie, `server-only` or the database.
- `server/` — authenticated, server-authoritative ingestion, grading, replay,
  revocation, audit, pull. Reuses the pure `modules/study-engine` and
  `modules/scheduler` (never a parallel "server version" of study logic) and is
  `server-only`.
- `client/` — browser sync orchestration: local selection from Dexie, push/pull,
  reconciliation/rebase, status derivation.

Phase 16 delivered online, authenticated, server-authoritative sync (Stage A).
Phase 17 adds the guest→account merge (below). Durable offline queue/PWA
(Phase 18) and full concurrent multi-device conflict resolution (Phase 19) are
still out of scope.

## The guest→account merge (Phase 17)

One authenticated endpoint, `POST /api/sync/guest-merge`, and a client flow
around it. `docs/DATA_MODEL.md` §10 is the data-flow reference and ADR-009 the
architectural one; what follows is where the code lives.

- `protocol/` — the import's wire contract alongside push/pull's: the request
  and response schemas, the merge reason codes, and the bounds. Pure, and
  shared verbatim by both sides, so the client cannot describe a snapshot the
  server would parse differently.
- `server/guest-merge.ts` — the coordinator. Serialises competing imports per
  account, records the import against a client-minted key, feeds the snapshot
  through the **same** ingestion pipeline as push (never a parallel one), and
  stamps the merge provenance. It remembers nothing between chunks that it does
  not read back from the database.
- `client/guest-merge-*.ts` — the flow, deliberately split so each part can be
  tested by calling it rather than by rendering it:
  - `-machine.ts`: the twelve states and every transition between them. This is
    where "signed out mid-merge", "different account signed in" and "retry
    budget exhausted" are decided.
  - `-chunking.ts`: packs the snapshot into requests. A chunk's unit is
    indivisible — an attempt travels with every event grading against it.
  - `-api.ts` / `-upload.ts`: one request, and the sequence of them.
  - `-finalise.ts`: drops the guest's source rows and re-keys what remains,
    in one Dexie transaction, and **only after** the account's copy is durable.
  - `-copy.ts` / `-surface.ts`: every string the learner sees, and whether the
    surface is showing. Both pure — that is what makes "no raw internal
    identifiers" checkable rather than merely intended.
  - `-runner.ts`: drives the machine, single-flight per account.

Two rules the merge does not get to bend. Consent precedes any upload — signing
in is not agreement. And the guest's local rows are the only copy until the
account's copy is durable, so nothing local is dropped before that, on any
path including failure.
