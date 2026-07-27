/**
 * Phase 16 online-sync wire protocol — public barrel.
 *
 * PURE and isomorphic: safe to import from both `modules/sync/client` (browser)
 * and `modules/sync/server` (Node/Postgres). Never re-export anything that
 * pulls in React, Dexie, `server-only` or the database from here.
 */
export * from "./constants";
export * from "./wire";
