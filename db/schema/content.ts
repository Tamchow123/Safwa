/**
 * Content-version registry (Phase 15). Stores release METADATA and
 * checksums only — no vocabulary tables exist in Postgres at any phase
 * before 21 (ARCHITECTURE.md §3, DATA_MODEL.md §11). Populated by
 * `pnpm db:register-content` (db/register-content.ts), never hand-edited.
 */
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Inlined via sql.raw() as a single-quoted SQL string literal, not
// interpolated with sql`` (which parameterises any non-column JS value —
// meaningless inside a static CHECK constraint).
const SHA256_HEX_PATTERN_SQL_LITERAL = sql.raw("'^[0-9a-f]{64}$'");

export const contentVersions = pgTable(
  "content_versions",
  {
    releaseId: text("release_id").primaryKey(),
    contentVersion: text("content_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    questionGeneratorVersion: text("question_generator_version").notNull(),
    entryCount: integer("entry_count").notNull(),
    checksumLearner: text("checksum_learner").notNull(),
    checksumValidation: text("checksum_validation").notNull(),
    checksumAssessment: text("checksum_assessment").notNull(),
    releaseStatus: text("release_status").notNull(),
    minimumSupportedClientVersion: text(
      "minimum_supported_client_version",
    ).notNull(),
    minimumSupportedEventSchema: integer(
      "minimum_supported_event_schema",
    ).notNull(),
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
      "content_versions_release_status_check",
      sql`${table.releaseStatus} IN ('active', 'supported', 'revoked')`,
    ),
    check("content_versions_entry_count_check", sql`${table.entryCount} > 0`),
    check(
      "content_versions_min_event_schema_check",
      sql`${table.minimumSupportedEventSchema} > 0`,
    ),
    check(
      "content_versions_checksum_learner_check",
      sql`${table.checksumLearner} ~ ${SHA256_HEX_PATTERN_SQL_LITERAL}`,
    ),
    check(
      "content_versions_checksum_validation_check",
      sql`${table.checksumValidation} ~ ${SHA256_HEX_PATTERN_SQL_LITERAL}`,
    ),
    check(
      "content_versions_checksum_assessment_check",
      sql`${table.checksumAssessment} ~ ${SHA256_HEX_PATTERN_SQL_LITERAL}`,
    ),
    // At most one row may have release_status = 'active': every indexed
    // value is the literal string 'active', so a second such row collides.
    uniqueIndex("content_versions_single_active_idx")
      .on(table.releaseStatus)
      .where(sql`${table.releaseStatus} = 'active'`),
  ],
);
