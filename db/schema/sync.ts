/**
 * Online-sync schema (Phase 16, migration 0002). Three new tables that the
 * Phase 15 learning/collection tables could not model:
 *
 * - `user_sync_state`  — the account-wide monotonic pull cursor. Every
 *   authoritative change bumps `sync_revision` and stamps the changed row's
 *   `last_sync_seq` with the new value, so `pull?since=<cursor>` can return a
 *   gap-free, ordered, paginated slice across components AND collections
 *   (a single component revision cannot represent an account-wide pull —
 *   phases-16.md §9.3).
 * - `sync_tombstones`  — deletions (bookmark/list) propagated to other browser
 *   contexts on pull (phases-16.md §22).
 * - `sync_audit_log`   — bounded, safe rejection/anomaly audit trail
 *   (phases-16.md §17). Never stores secrets, tokens, full request bodies or
 *   assessment-manifest contents.
 *
 * All three cascade on user deletion (phases-16.md §32 — account deletion must
 * cascade every Phase 16 table). The `last_sync_seq` cursor columns added to
 * the existing study_components/bookmarks/custom_lists/user_settings tables
 * live in their own schema files.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  type PgColumn,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "@/db/schema/auth";
// The pure wire protocol is the single source of truth for these vocabularies;
// importing it here (protocol is pure/isomorphic, never imports the DB) keeps
// the CHECK constraints from drifting away from the wire (no duplicate literals).
import {
  SYNC_AUDIT_SEVERITIES,
  SYNC_ITEM_KINDS,
} from "@/modules/sync/protocol";

/** Deletable collection kinds a tombstone can describe. */
export const SYNC_TOMBSTONE_KINDS = ["bookmark", "list"] as const;
/** Mutation kinds an audit entry can describe (mirrors the wire item kinds). */
export const SYNC_AUDIT_ITEM_KINDS = SYNC_ITEM_KINDS;
export { SYNC_AUDIT_SEVERITIES };

/**
 * Build a `column IN ('a', 'b', ...)` CHECK from a compile-time constant enum
 * array so the constraint literals are derived from one source. Values are
 * static string constants (never user input), so inlining them is injection-safe.
 */
function inList(column: PgColumn, values: readonly string[]): SQL {
  const literals = values.map((value) => `'${value}'`).join(", ");
  return sql`${column} IN (${sql.raw(literals)})`;
}

/**
 * One row per account. `sync_revision` is the account-wide monotonic cursor
 * source: an ingestion transaction that changes authoritative state bumps it
 * once and stamps `last_sync_seq` on every row it changed.
 */
export const userSyncState = pgTable("user_sync_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  syncRevision: bigint("sync_revision", { mode: "number" })
    .notNull()
    .default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * A deletion to propagate on pull. `ref` is the entry id (as text) for a
 * bookmark, or the list id for a list. One tombstone per (user, kind, ref);
 * re-deleting is an idempotent upsert that re-stamps `last_sync_seq`.
 */
export const syncTombstones = pgTable(
  "sync_tombstones",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    lastSyncSeq: bigint("last_sync_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "sync_tombstones_kind_check",
      inList(table.kind, SYNC_TOMBSTONE_KINDS),
    ),
    check("sync_tombstones_seq_check", sql`${table.lastSyncSeq} >= 0`),
    unique("sync_tombstones_user_kind_ref_unique").on(
      table.userId,
      table.kind,
      table.ref,
    ),
    index("sync_tombstones_user_seq_idx").on(table.userId, table.lastSyncSeq),
  ],
);

/**
 * Bounded, safe audit trail for ingestion anomalies and rejections. Stores
 * only structured, redacted diagnostic fields — never secrets, tokens,
 * cookies, full request bodies, learner answer content or manifest contents.
 */
export const syncAuditLog = pgTable(
  "sync_audit_log",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemKind: text("item_kind").notNull(),
    itemId: text("item_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    severity: text("severity").notNull(),
    releaseId: text("release_id"),
    componentKey: text("component_key"),
    correlationId: text("correlation_id"),
    clockSuspect: boolean("clock_suspect").notNull().default(false),
    timezoneCorrected: boolean("timezone_corrected").notNull().default(false),
    // Redacted, structured diagnostic detail only (e.g. claimed-vs-canonical
    // rating). NEVER raw request bodies, answers, secrets or manifest contents.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "sync_audit_log_item_kind_check",
      inList(table.itemKind, SYNC_AUDIT_ITEM_KINDS),
    ),
    check(
      "sync_audit_log_severity_check",
      inList(table.severity, SYNC_AUDIT_SEVERITIES),
    ),
    index("sync_audit_log_user_created_idx").on(table.userId, table.createdAt),
  ],
);
