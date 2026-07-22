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
  pgTable,
  text,
  timestamp,
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

/** Future guest->account merge audit + idempotency anchor (Phase 17 populates it). */
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
    importKey: text("import_key").notNull().unique(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    eventCount: integer("event_count").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    result: text("result").notNull(),
  },
  (table) => [
    check(
      "guest_imports_result_check",
      sql`${table.result} IN ('applied', 'no_op', 'rejected')`,
    ),
    check("guest_imports_event_count_check", sql`${table.eventCount} >= 0`),
    check("guest_imports_attempt_count_check", sql`${table.attemptCount} >= 0`),
    index("guest_imports_user_imported_idx").on(table.userId, table.importedAt),
  ],
);
