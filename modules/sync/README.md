# modules/sync

Synchronisation logic (Phases 16–19): the outbound mutation queue, event
push/pull, client rebase handling and sync-status state. The server-side
ingestion pipeline shares validation logic with this module — see
`docs/OFFLINE_AND_SYNC.md`.

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

Phase 16 delivers online, authenticated, server-authoritative sync (Stage A).
Guest-to-account merge (Phase 17), durable offline queue/PWA (Phase 18) and full
concurrent multi-device conflict resolution (Phase 19) are out of scope.
