/**
 * Online-sync wire protocol — public barrel. Phase 16's push/pull vocabulary,
 * the shared integrity canonicalisation, and Phase 17's staged guest-merge
 * protocol.
 *
 * PURE and isomorphic: safe to import from both `modules/sync/client` (browser)
 * and `modules/sync/server` (Node/Postgres). Never re-export anything that
 * pulls in React, Dexie, `server-only` or the database from here.
 */
export * from "./canonical-json";
export * from "./constants";
export * from "./guest-merge";
export * from "./wire";
