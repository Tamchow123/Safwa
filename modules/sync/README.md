# modules/sync

Future home of synchronisation logic (Phases 16–19): the outbound mutation
queue, event push/pull, client rebase handling and sync-status state. The
server-side ingestion pipeline shares validation logic with this module —
see `docs/OFFLINE_AND_SYNC.md`.

No implementation exists yet by design (Phase 1 creates boundaries only).
