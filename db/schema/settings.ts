/**
 * Account-side settings and merge-audit tables (Phase 15). Bounds/enums here
 * mirror the existing shared local contracts exactly — `lib/preferences/
 * app-theme.ts` (APP_THEMES), `lib/preferences/arabic-font-scale.ts`
 * (ARABIC_FONT_SCALES), `modules/profile/timezone.ts` (TimezonePreference)
 * and `modules/profile/session-defaults.ts` (SESSION_DEFAULTS_BOUNDS) — so a
 * future extraction of shared validation constants has one source of truth
 * to converge on. This phase does not copy local settings into these rows,
 * nor read them back into Dexie (Phase 16/17 reconciliation).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "@/db/schema/auth";

export const userSettings = pgTable(
  "user_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    theme: text("theme").notNull().default("system"),
    arabicFontScale: text("arabic_font_scale").notNull().default("default"),
    timezoneMode: text("timezone_mode").notNull().default("browser"),
    timezoneName: text("timezone_name"),
    questionCount: integer("question_count").notNull().default(20),
    optionCount: integer("option_count").notNull().default(4),
    dailyNewTarget: integer("daily_new_target").notNull().default(10),
    dailyReviewTarget: integer("daily_review_target").notNull().default(20),
    // Account-wide pull cursor stamp (Phase 16).
    lastSyncSeq: bigint("last_sync_seq", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check("user_settings_last_sync_seq_check", sql`${table.lastSyncSeq} >= 0`),
    check(
      "user_settings_theme_check",
      sql`${table.theme} IN ('light', 'dark', 'system')`,
    ),
    check(
      "user_settings_arabic_font_scale_check",
      sql`${table.arabicFontScale} IN ('small', 'default', 'large')`,
    ),
    check(
      "user_settings_timezone_mode_check",
      sql`${table.timezoneMode} IN ('browser', 'iana')`,
    ),
    check(
      "user_settings_timezone_shape_check",
      sql`(${table.timezoneMode} = 'browser' AND ${table.timezoneName} IS NULL)
          OR (${table.timezoneMode} = 'iana' AND ${table.timezoneName} IS NOT NULL AND char_length(${table.timezoneName}) > 0)`,
    ),
    check(
      "user_settings_question_count_check",
      sql`${table.questionCount} BETWEEN 1 AND 100`,
    ),
    check(
      "user_settings_option_count_check",
      sql`${table.optionCount} BETWEEN 2 AND 8`,
    ),
    check(
      "user_settings_daily_new_target_check",
      sql`${table.dailyNewTarget} BETWEEN 0 AND 100`,
    ),
    check(
      "user_settings_daily_review_target_check",
      sql`${table.dailyReviewTarget} BETWEEN 0 AND 500`,
    ),
  ],
);

/**
 * The guest→account merge's durable audit record AND its idempotency anchor
 * (phases-17.md §15). Phase 15 created the table as a placeholder; Phase 17
 * gives it the columns the staged protocol actually needs.
 *
 * The row is the server's memory of an import between requests, which is what
 * makes the whole thing resumable: `begin` creates or finds it, each `chunk`
 * advances it, `finalize` concludes it. Nothing else remembers.
 *
 * IN-PROGRESS STATE AND TERMINAL OUTCOME ARE SEPARATE COLUMNS. `status` is the
 * lifecycle (open → completed/rejected); `result` is the outcome finalisation
 * reported and is NULL until it reports one. Folding them together would force
 * an interrupted-but-partially-applied import to be recorded as `rejected` —
 * telling a later reader the merge terminally failed when it is in fact
 * retryable, exactly the false rollback claim §29 forbids. So `result` also
 * admits `incomplete`: finalisation was attempted and could not conclude, while
 * `status` stays `open` so the client resumes under the same key.
 */
export const guestImports = pgTable(
  "guest_imports",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    /**
     * The client-minted idempotency key. GLOBALLY unique, which is what makes
     * §15's "an import key cannot be claimed across accounts" a database
     * invariant: a key names at most one row, and that row names one account, so
     * a second account presenting the same key collides rather than being
     * quietly served.
     */
    importKey: text("import_key").notNull().unique(),
    /**
     * Canonical hash of the snapshot this key is bound to (§12). Compared on
     * every stage: the same key with materially different content is a payload
     * conflict, never a silent merge of data the key was not opened for.
     *
     * NOT NULL with no default: an import without a snapshot hash has no
     * conflict detector at all, so there is no sensible value to invent for one.
     * The migration can add it unconditionally because nothing has ever written
     * to this table — Phase 15 created it as a placeholder and Phase 16 never
     * used it — so an existing row would mean the assumption is wrong, and the
     * migration failing loudly is the right outcome.
     */
    snapshotHash: text("snapshot_hash").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Lifecycle. Mirrors the protocol's GUEST_IMPORT_SERVER_STATUSES. */
    status: text("status").notNull().default("open"),
    /** What the client declared at `begin`; finalisation checks arrivals against it. */
    declaredItems: integer("declared_items").notNull().default(0),
    /** Items durably accepted so far — the resume denominator. */
    acceptedItems: integer("accepted_items").notNull().default(0),
    /** The next chunk index expected; a client resumes from here. */
    nextChunkIndex: integer("next_chunk_index").notNull().default(0),
    /**
     * Cumulative custom lists accepted under this key. Persisted because the
     * per-request wire schema cannot bound a cross-chunk total (SEC-003): the
     * ceiling is only enforceable against a running count that survives between
     * requests, and this column is that count.
     */
    acceptedLists: integer("accepted_lists").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    /** The terminal outcome, or NULL while the import is still open. */
    result: text("result"),
    /** Cursor the client should pull from after a successful merge. */
    finalServerCursor: bigint("final_server_cursor", { mode: "number" }),
    /**
     * The post-merge summary COUNTS, and nothing else (§15 "safe result
     * metadata", §30 "no raw payloads in logs"). Stored so a resubmission after
     * success replays the same numbers without reapplying anything. Never a
     * payload, an answer, or an Arabic string.
     */
    summary: jsonb("summary"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "guest_imports_status_check",
      sql`${table.status} IN ('open', 'completed', 'rejected')`,
    ),
    check(
      "guest_imports_result_check",
      sql`${table.result} IS NULL OR ${table.result} IN ('applied', 'no_op', 'rejected', 'incomplete')`,
    ),
    /**
     * The status/result pairing, EXHAUSTIVELY. Splitting lifecycle from outcome
     * only helps if the two cannot contradict each other; a check that merely
     * required "some result once concluded" would still admit `open` +
     * `applied` (a terminal outcome recorded while the lifecycle says the import
     * is still running) or `rejected` + `applied`. A resubmission arriving at
     * such a row reads `open` and resumes, while a summary reading `result` says
     * the merge finished — the false-completion the split exists to prevent.
     *
     * The three legal shapes, and nothing else:
     *   open      — still running. No completion time. `result` is NULL, or
     *               `incomplete` when finalisation was attempted and could not
     *               conclude (§29: neither succeeded nor rolled back).
     *   completed — applied, or a no-op when everything in it was already there.
     *   rejected  — refused; the outcome can only be the refusal itself.
     *
     * Every branch that compares `result` guards it with `IS NOT NULL` FIRST.
     * A CHECK constraint rejects a row only when its expression is FALSE, not
     * when it is NULL — so `result IN ('applied','no_op')` against a NULL result
     * evaluates to NULL, the whole OR evaluates to NULL, and the row is
     * ACCEPTED. Without these guards this constraint silently admitted a
     * `completed` row with no result at all: exactly the "a concluded import
     * must say how it concluded" case it exists to forbid.
     */
    check(
      "guest_imports_completion_check",
      sql`(${table.status} = 'open' AND ${table.completedAt} IS NULL
           AND (${table.result} IS NULL OR ${table.result} = 'incomplete'))
          OR (${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL
              AND ${table.result} IS NOT NULL
              AND ${table.result} IN ('applied', 'no_op'))
          OR (${table.status} = 'rejected' AND ${table.completedAt} IS NOT NULL
              AND ${table.result} IS NOT NULL
              AND ${table.result} = 'rejected')`,
    ),
    // The hash's shape is an invariant of the data, so the database states it
    // too. The protocol already rejects a malformed hash at the boundary; this
    // is what still holds when a seed script, a backfill or a repair query
    // writes without going through that boundary.
    check(
      "guest_imports_snapshot_hash_check",
      sql`${table.snapshotHash} ~ '^[0-9a-f]{64}$'`,
    ),
    /**
     * `summary` may hold NUMBERS AND NOTHING ELSE (§15 "safe result metadata",
     * §30 "no raw payloads in logs", "no Arabic answers copied into audit
     * logs"). Every field of `GuestMergeSummary` is a count, so anything
     * non-numeric in here is by definition something that does not belong — a
     * payload fragment, an answer, a stack trace.
     *
     * Every other column on this table is defended by the database rather than
     * by the code that writes it, and this is the one §30 names outright. A
     * comment would only describe the intent; this refuses the write. It costs
     * nothing and it survives a future maintainer adding a "just for debugging"
     * field to the object the coordinator serialises.
     */
    check(
      "guest_imports_summary_numeric_check",
      sql`${table.summary} IS NULL
          OR (jsonb_typeof(${table.summary}) = 'object'
              AND NOT jsonb_path_exists(${table.summary}, '$.* ? (@.type() != "number")'))`,
    ),
    check("guest_imports_event_count_check", sql`${table.eventCount} >= 0`),
    check("guest_imports_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "guest_imports_declared_items_check",
      sql`${table.declaredItems} >= 0`,
    ),
    check(
      "guest_imports_accepted_items_check",
      sql`${table.acceptedItems} >= 0`,
    ),
    check(
      "guest_imports_next_chunk_index_check",
      sql`${table.nextChunkIndex} >= 0`,
    ),
    check(
      "guest_imports_accepted_lists_check",
      sql`${table.acceptedLists} >= 0`,
    ),
    check(
      "guest_imports_final_server_cursor_check",
      sql`${table.finalServerCursor} IS NULL OR ${table.finalServerCursor} >= 0`,
    ),
    index("guest_imports_user_imported_idx").on(table.userId, table.importedAt),
    // Resolving a key on every chunk is the hot path.
    index("guest_imports_key_idx").on(table.importKey),
    /**
     * One account merges a given snapshot AT MOST ONCE. This turns §15's "the
     * same successful import resubmitted is a no-op" from application logic into
     * a database invariant: even if a client mints a fresh key for a snapshot it
     * already merged, the second completion cannot be recorded, so the same
     * history cannot be applied twice under two keys. Partial (WHERE completed)
     * so retries and abandoned attempts of the same snapshot stay legal.
     */
    uniqueIndex("guest_imports_user_snapshot_completed_idx")
      .on(table.userId, table.snapshotHash)
      .where(sql`${table.status} = 'completed'`),
  ],
);
