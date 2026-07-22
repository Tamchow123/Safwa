/**
 * Learning-state schema (Phase 15, migration 0001): `skill_types` (lookup),
 * `study_components` (FSRS cards — the composite skill/shape FK + shape
 * CHECKs + shape-predicated partial unique indexes are load-bearing, see
 * DATA_MODEL.md §3-4), `study_sessions`, `study_attempts`, `review_events`
 * (causal DAG — deliberately NO immediate parent FK, see below),
 * `daily_activity` (derived cache). No vocabulary tables — entry/skill
 * identity is carried by stable ids the client's shared natural-key builder
 * (modules/study-engine/natural-key.ts) already enforces; Postgres validates
 * structure, the validation manifest validates content eligibility.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "@/db/schema/auth";
import { contentVersions } from "@/db/schema/content";

export const COMPONENT_SHAPES = ["form_direction", "entry_level"] as const;
export const SOURCE_FIELDS = [
  "madi",
  "mudari",
  "masdar",
  "ism_fail",
  "amr",
  "nahi",
] as const;
export const DIRECTIONS = ["arabic_to_english", "english_to_arabic"] as const;
export const LEARNER_STATES = [
  "not_started",
  "learning",
  "mastered",
  "needs_review",
] as const;
export const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;
export const SESSION_MODES = [
  "mc",
  "flashcard",
  "timed",
  "test",
  "timed_test",
] as const;
export const REVIEW_RATINGS = ["again", "hard", "good", "easy"] as const;
export const REVIEW_EVENT_STATUSES = [
  "scheduling",
  "reinforcement",
  "conflict_demoted",
  "revoked",
  "pending_parent",
] as const;

/** Seeded exactly once with the current 5 skill types (db/migrate.ts). */
export const skillTypes = pgTable(
  "skill_types",
  {
    id: text("id").primaryKey(),
    componentShape: text("component_shape").notNull(),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    unique("skill_types_id_shape_unique").on(table.id, table.componentShape),
    check(
      "skill_types_component_shape_check",
      sql`${table.componentShape} IN ('form_direction', 'entry_level')`,
    ),
  ],
);

export const studyComponents = pgTable(
  "study_components",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryId: integer("entry_id").notNull(),
    skillTypeId: text("skill_type_id").notNull(),
    componentShape: text("component_shape").notNull(),
    sourceField: text("source_field"),
    direction: text("direction"),
    stability: doublePrecision("stability"),
    difficulty: doublePrecision("difficulty"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    fsrsState: text("fsrs_state"),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    lastReviewAt: timestamp("last_review_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    learnerState: text("learner_state").notNull().default("not_started"),
    // Account-wide pull cursor stamp (Phase 16): the user_sync_state.sync_revision
    // value at this component's last authoritative change.
    lastSyncSeq: bigint("last_sync_seq", { mode: "number" })
      .notNull()
      .default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.skillTypeId, table.componentShape],
      foreignColumns: [skillTypes.id, skillTypes.componentShape],
      name: "study_components_skill_shape_fk",
    }),
    check(
      "study_components_shape_check",
      sql`(${table.componentShape} = 'form_direction' AND ${table.sourceField} IS NOT NULL AND ${table.direction} IS NOT NULL)
          OR (${table.componentShape} = 'entry_level' AND ${table.sourceField} IS NULL AND ${table.direction} IS NULL)`,
    ),
    check(
      "study_components_source_field_check",
      sql`${table.sourceField} IS NULL OR ${table.sourceField} IN ('madi', 'mudari', 'masdar', 'ism_fail', 'amr', 'nahi')`,
    ),
    check(
      "study_components_direction_check",
      sql`${table.direction} IS NULL OR ${table.direction} IN ('arabic_to_english', 'english_to_arabic')`,
    ),
    check(
      "study_components_learner_state_check",
      sql`${table.learnerState} IN ('not_started', 'learning', 'mastered', 'needs_review')`,
    ),
    check(
      "study_components_fsrs_state_check",
      sql`${table.fsrsState} IS NULL OR ${table.fsrsState} IN ('new', 'learning', 'review', 'relearning')`,
    ),
    check("study_components_reps_check", sql`${table.reps} >= 0`),
    check("study_components_lapses_check", sql`${table.lapses} >= 0`),
    check("study_components_revision_check", sql`${table.revision} >= 0`),
    check(
      "study_components_last_sync_seq_check",
      sql`${table.lastSyncSeq} >= 0`,
    ),
    check(
      "study_components_stability_check",
      sql`${table.stability} IS NULL OR (${table.stability} >= 0 AND ${table.stability} < 'infinity'::double precision)`,
    ),
    check(
      "study_components_difficulty_check",
      sql`${table.difficulty} IS NULL OR (${table.difficulty} BETWEEN 0 AND 10)`,
    ),
    uniqueIndex("study_components_form_unique")
      .on(
        table.userId,
        table.entryId,
        table.skillTypeId,
        table.sourceField,
        table.direction,
      )
      .where(sql`${table.componentShape} = 'form_direction'`),
    uniqueIndex("study_components_entry_unique")
      .on(table.userId, table.entryId, table.skillTypeId)
      .where(sql`${table.componentShape} = 'entry_level'`),
    index("study_components_due_idx").on(table.userId, table.dueAt),
    // PARTIAL pull-cursor index: only rows that have actually synced
    // (last_sync_seq > 0) are indexed, so it serves `WHERE user_id = X AND
    // last_sync_seq > cursor ORDER BY last_sync_seq` for pull without competing
    // with study_components_due_idx for due-lookups over the (default-0)
    // unsynced rows — both indexes coexist, each optimal for its own query.
    index("study_components_sync_idx")
      .on(table.userId, table.lastSyncSeq)
      .where(sql`${table.lastSyncSeq} > 0`),
  ],
);

export const studySessions = pgTable(
  "study_sessions",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    config: jsonb("config").notNull(),
    // The AUTHORITATIVE content identity (modules/study-engine/session.ts's
    // own doc comment): contentVersion is human-readable metadata that can
    // repeat across corrected releases, so it can never substitute for
    // releaseId when Phase 16 reconstructs which manifests generated a
    // session/attempt/event. Never nullable — every session is created
    // against a specific registered release.
    releaseId: text("release_id")
      .notNull()
      .references(() => contentVersions.releaseId),
    contentVersion: text("content_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    questionCount: integer("question_count"),
    firstAttemptCorrect: integer("first_attempt_correct"),
    recovered: integer("recovered"),
    hinted: integer("hinted"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "study_sessions_mode_check",
      sql`${table.mode} IN ('mc', 'flashcard', 'timed', 'test', 'timed_test')`,
    ),
    check(
      "study_sessions_aggregates_check",
      sql`(${table.questionCount} IS NULL OR ${table.questionCount} >= 0)
          AND (${table.firstAttemptCorrect} IS NULL OR ${table.firstAttemptCorrect} >= 0)
          AND (${table.recovered} IS NULL OR ${table.recovered} >= 0)
          AND (${table.hinted} IS NULL OR ${table.hinted} >= 0)`,
    ),
    index("study_sessions_user_started_idx").on(table.userId, table.startedAt),
  ],
);

export const studyAttempts = pgTable(
  "study_attempts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => studySessions.id, {
      onDelete: "set null",
    }),
    studyComponentId: uuid("study_component_id").references(
      () => studyComponents.id,
      { onDelete: "set null" },
    ),
    entryId: integer("entry_id").notNull(),
    skillTypeId: text("skill_type_id").notNull(),
    sourceField: text("source_field"),
    direction: text("direction"),
    promptField: text("prompt_field"),
    promptRef: jsonb("prompt_ref").notNull(),
    selectedAnswerRef: jsonb("selected_answer_ref"),
    correctAnswerRef: jsonb("correct_answer_ref").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    isFirstAttempt: boolean("is_first_attempt").notNull(),
    isReinforcement: boolean("is_reinforcement").notNull(),
    hintUsed: boolean("hint_used").notNull().default(false),
    hintType: text("hint_type"),
    responseTimeMs: integer("response_time_ms"),
    questionPosition: integer("question_position").notNull(),
    mode: text("mode").notNull(),
    optionCount: integer("option_count"),
    perQuestionLimitMs: integer("per_question_limit_ms"),
    questionInstanceId: text("question_instance_id").notNull(),
    questionSeed: text("question_seed").notNull(),
    questionGeneratorVersion: text("question_generator_version").notNull(),
    occurredAtUtc: timestamp("occurred_at_utc", {
      withTimezone: true,
    }).notNull(),
    timezoneAtEvent: text("timezone_at_event").notNull(),
    utcOffsetMinutesAtEvent: integer("utc_offset_minutes_at_event").notNull(),
    localDateAtEvent: date("local_date_at_event").notNull(),
    timezoneSource: text("timezone_source").notNull(),
    deviceId: text("device_id").notNull(),
    // See studySessions.releaseId's doc comment — same authoritative-identity
    // rationale applies per-attempt, since two attempts in the same session
    // could in principle be answered against different active releases if a
    // release changed mid-session (Phase 16 concern; the column must exist
    // now so that reconstruction is possible once ingestion lands).
    releaseId: text("release_id")
      .notNull()
      .references(() => contentVersions.releaseId),
    contentVersion: text("content_version").notNull(),
    // Hash of the attempt's immutable payload — a second delivery of the same
    // attempt id with a DIFFERENT payload is a conflict (rejected + audited, §8.5).
    idempotencyPayloadHash: text("idempotency_payload_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "study_attempts_source_field_check",
      sql`${table.sourceField} IS NULL OR ${table.sourceField} IN ('madi', 'mudari', 'masdar', 'ism_fail', 'amr', 'nahi')`,
    ),
    check(
      "study_attempts_direction_check",
      sql`${table.direction} IS NULL OR ${table.direction} IN ('arabic_to_english', 'english_to_arabic')`,
    ),
    check(
      "study_attempts_mode_check",
      sql`${table.mode} IN ('mc', 'flashcard', 'timed', 'test', 'timed_test')`,
    ),
    check(
      "study_attempts_timezone_source_check",
      sql`${table.timezoneSource} IN ('browser_detected', 'user_setting', 'server_fallback')`,
    ),
    check(
      "study_attempts_response_time_check",
      sql`${table.responseTimeMs} IS NULL OR ${table.responseTimeMs} >= 0`,
    ),
    check(
      "study_attempts_question_position_check",
      sql`${table.questionPosition} >= 0`,
    ),
    // Mirrors the shared generator's MIN_OPTION_COUNT/MAX_OPTION_COUNT
    // bounds (modules/study-engine/generator.ts) — the client enforces this
    // range already, but the database must reject an out-of-range value
    // independently rather than only checking a floor.
    check(
      "study_attempts_option_count_check",
      sql`${table.optionCount} IS NULL OR ${table.optionCount} BETWEEN 2 AND 8`,
    ),
    check(
      "study_attempts_time_limit_check",
      sql`${table.perQuestionLimitMs} IS NULL OR ${table.perQuestionLimitMs} >= 0`,
    ),
    index("study_attempts_user_occurred_idx").on(
      table.userId,
      table.occurredAtUtc,
    ),
    index("study_attempts_user_entry_idx").on(table.userId, table.entryId),
    index("study_attempts_user_local_date_idx").on(
      table.userId,
      table.localDateAtEvent,
    ),
    index("study_attempts_component_idx").on(table.studyComponentId),
    index("study_attempts_session_idx").on(table.sessionId),
  ],
);

/**
 * Causal-lineage event log. `parent_event_id` is deliberately a plain
 * nullable uuid column, NOT a foreign key: Phase 16/19 must be able to store
 * a `pending_parent` event before its parent has arrived (out-of-order
 * sync), which an immediate FK would reject outright. Lineage integrity is
 * enforced by application-level replay logic, not the database, exactly as
 * DATA_MODEL.md §6 documents. Branch resolution is not implemented yet.
 */
export const reviewEvents = pgTable(
  "review_events",
  {
    eventId: uuid("event_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    studyComponentId: uuid("study_component_id")
      .notNull()
      .references(() => studyComponents.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id").references(() => studyAttempts.id, {
      onDelete: "set null",
    }),
    rating: text("rating").notNull(),
    status: text("status").notNull(),
    baseServerRevision: bigint("base_server_revision", {
      mode: "number",
    }).notNull(),
    parentEventId: uuid("parent_event_id"),
    clientComponentRevision: bigint("client_component_revision", {
      mode: "number",
    }).notNull(),
    occurredAtClient: timestamp("occurred_at_client", {
      withTimezone: true,
    }).notNull(),
    occurredAtCanonical: timestamp("occurred_at_canonical", {
      withTimezone: true,
    }).notNull(),
    serverReceivedAt: timestamp("server_received_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    deviceId: text("device_id").notNull(),
    clientSequence: bigint("client_sequence", { mode: "number" }).notNull(),
    sessionId: uuid("session_id").references(() => studySessions.id, {
      onDelete: "set null",
    }),
    // See studySessions.releaseId's doc comment — same rationale: the
    // review event's rating was computed against a specific release's
    // question, and contentVersion alone cannot disambiguate which one.
    releaseId: text("release_id")
      .notNull()
      .references(() => contentVersions.releaseId),
    contentVersion: text("content_version").notNull(),
    timezoneAtEvent: text("timezone_at_event").notNull(),
    utcOffsetMinutesAtEvent: integer("utc_offset_minutes_at_event").notNull(),
    localDateAtEvent: date("local_date_at_event").notNull(),
    timezoneSource: text("timezone_source").notNull(),
    timezoneCorrected: boolean("timezone_corrected").notNull().default(false),
    // The client clock was implausible and canonical time was corrected (§13).
    clockSuspect: boolean("clock_suspect").notNull().default(false),
    // Hash of the event's immutable payload — a second delivery of the same
    // event_id with a DIFFERENT payload is a conflict (rejected + audited, §8.5).
    idempotencyPayloadHash: text("idempotency_payload_hash"),
    // Set when the event is revoked by a post-sync undo (§16); the row is kept
    // (history preserved) and excluded from replay.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Safe expiry for a held pending_parent event (§14.2). Null unless pending.
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    // Account-wide pull cursor stamp (Phase 16). An event carries its OWN cursor
    // value (not just the parent component's) so pull can source the wire
    // wireEventStatusSchema.syncSeq independently: an in-place status change
    // (revocation, pending_parent resolution) stamps this even when the parent
    // component's FSRS state is unchanged, so a second context never misses it.
    lastSyncSeq: bigint("last_sync_seq", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "review_events_rating_check",
      sql`${table.rating} IN ('again', 'hard', 'good', 'easy')`,
    ),
    check(
      "review_events_status_check",
      sql`${table.status} IN ('scheduling', 'reinforcement', 'conflict_demoted', 'revoked', 'pending_parent')`,
    ),
    check(
      "review_events_timezone_source_check",
      sql`${table.timezoneSource} IN ('browser_detected', 'user_setting', 'server_fallback')`,
    ),
    check(
      "review_events_base_revision_check",
      sql`${table.baseServerRevision} >= 0`,
    ),
    check(
      "review_events_client_revision_check",
      sql`${table.clientComponentRevision} >= 0`,
    ),
    check(
      "review_events_client_sequence_check",
      sql`${table.clientSequence} >= 0`,
    ),
    check("review_events_last_sync_seq_check", sql`${table.lastSyncSeq} >= 0`),
    index("review_events_component_canonical_idx").on(
      table.studyComponentId,
      table.occurredAtCanonical,
    ),
    // PARTIAL pull-cursor index (only synced rows), mirroring study_components.
    index("review_events_sync_idx")
      .on(table.userId, table.lastSyncSeq)
      .where(sql`${table.lastSyncSeq} > 0`),
    index("review_events_user_received_idx").on(
      table.userId,
      table.serverReceivedAt,
    ),
    index("review_events_pending_parent_idx")
      .on(table.studyComponentId)
      .where(sql`${table.status} = 'pending_parent'`),
  ],
);

/** Derived cache — rebuildable from study_attempts/review_events at any time. */
export const dailyActivity = pgTable(
  "daily_activity",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    attempts: integer("attempts").notNull().default(0),
    reviews: integer("reviews").notNull().default(0),
    newItems: integer("new_items").notNull().default(0),
    studyMs: integer("study_ms").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("daily_activity_user_date_unique").on(table.userId, table.localDate),
    check("daily_activity_attempts_check", sql`${table.attempts} >= 0`),
    check("daily_activity_reviews_check", sql`${table.reviews} >= 0`),
    check("daily_activity_new_items_check", sql`${table.newItems} >= 0`),
    check("daily_activity_study_ms_check", sql`${table.studyMs} >= 0`),
  ],
);
