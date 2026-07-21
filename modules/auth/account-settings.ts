/**
 * Server-side account settings (Phase 15, phases-15.md §38-39). One row
 * per user in `user_settings`. `getAccountSettings` reads it. Writes
 * (`upsertAccountSettings`/`resetAccountSettings`) run inside a
 * transaction guarded by a `pg_advisory_xact_lock` keyed on the user id —
 * the SAME pattern db/register-content.ts uses for its not-yet-existing
 * release rows, and needed here for the identical reason: a plain
 * `SELECT ... FOR UPDATE` only locks a row that already exists, so it
 * cannot by itself prevent two concurrent read-merge-write requests for
 * the SAME user (e.g. two open tabs, each patching a different field
 * group) from racing — the second to commit would otherwise silently
 * overwrite the first's already-saved change with its own stale copy of
 * that field group. The advisory lock provides real mutual exclusion
 * regardless of whether the row exists yet, and releases automatically
 * at commit/rollback.
 *
 * Every field is sanitised through the SAME shared validators the local
 * Dexie settings already use (lib/preferences/app-theme.ts,
 * lib/preferences/arabic-font-scale.ts, modules/profile/timezone.ts,
 * modules/profile/session-defaults.ts) so an account row can never hold a
 * value the client-side UI would reject. This phase does NOT copy local
 * settings into these rows, nor read them back into Dexie — this is a
 * separate, server-owned settings surface (Phase 16/17 reconciliation).
 */
import "server-only";
import { eq, sql } from "drizzle-orm";
import { isAppTheme, type AppTheme } from "@/lib/preferences/app-theme";
import {
  isArabicFontScale,
  type ArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";
import { getDb, type Database } from "@/db/client";
import { userSettings } from "@/db/schema";
import {
  DEFAULT_SESSION_DEFAULTS,
  sanitizeSessionDefaults,
  type SessionDefaults,
} from "@/modules/profile/session-defaults";
import {
  DEFAULT_TIMEZONE_PREFERENCE,
  sanitizeTimezonePreference,
  type TimezonePreference,
} from "@/modules/profile/timezone";

export type AccountSettings = {
  theme: AppTheme;
  arabicFontScale: ArabicFontScale;
  timezone: TimezonePreference;
  sessionDefaults: SessionDefaults;
};

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  theme: "system",
  arabicFontScale: "default",
  timezone: DEFAULT_TIMEZONE_PREFERENCE,
  sessionDefaults: DEFAULT_SESSION_DEFAULTS,
};

/** A caller-supplied partial update; every field is independently optional. */
export type AccountSettingsPatch = Partial<{
  theme: unknown;
  arabicFontScale: unknown;
  timezone: unknown;
  sessionDefaults: unknown;
}>;

type SettingsRow = typeof userSettings.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function rowToSettings(row: SettingsRow | undefined): AccountSettings {
  if (!row) return DEFAULT_ACCOUNT_SETTINGS;
  return {
    theme: isAppTheme(row.theme) ? row.theme : DEFAULT_ACCOUNT_SETTINGS.theme,
    arabicFontScale: isArabicFontScale(row.arabicFontScale)
      ? row.arabicFontScale
      : DEFAULT_ACCOUNT_SETTINGS.arabicFontScale,
    timezone: sanitizeTimezonePreference(
      row.timezoneMode === "iana" && row.timezoneName
        ? { mode: "iana", timezone: row.timezoneName }
        : { mode: "browser" },
    ),
    sessionDefaults: sanitizeSessionDefaults({
      questionCount: row.questionCount,
      optionCount: row.optionCount,
      newPerDay: row.dailyNewTarget,
      reviewsPerDay: row.dailyReviewTarget,
    }),
  };
}

/** The single source of truth for the AccountSettings <-> column mapping. */
function toColumns(settings: AccountSettings) {
  return {
    theme: settings.theme,
    arabicFontScale: settings.arabicFontScale,
    timezoneMode: settings.timezone.mode,
    timezoneName:
      settings.timezone.mode === "iana" ? settings.timezone.timezone : null,
    questionCount: settings.sessionDefaults.questionCount,
    optionCount: settings.sessionDefaults.optionCount,
    dailyNewTarget: settings.sessionDefaults.newPerDay,
    dailyReviewTarget: settings.sessionDefaults.reviewsPerDay,
  };
}

async function lockUserSettingsRow(
  tx: Tx,
  userId: string,
): Promise<AccountSettings> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}), 0)`);
  const [row] = await tx
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .for("update");
  return rowToSettings(row);
}

/** Read the effective settings for a user (an absent row = documented defaults). */
export async function getAccountSettings(
  userId: string,
): Promise<AccountSettings> {
  const [row] = await getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return rowToSettings(row);
}

/**
 * Merge `patch` onto the user's current settings (each field sanitised
 * independently, falling back to its documented default when the
 * supplied value is absent or invalid — never a partially-applied
 * invalid value), then upsert the single row. The read-merge-write runs
 * inside one advisory-locked transaction so a concurrent patch touching a
 * different field group can never be silently overwritten (see the
 * module doc comment).
 */
export async function upsertAccountSettings(
  userId: string,
  patch: AccountSettingsPatch,
): Promise<AccountSettings> {
  return getDb().transaction(async (tx) => {
    const current = await lockUserSettingsRow(tx, userId);
    const next: AccountSettings = {
      theme:
        patch.theme !== undefined && isAppTheme(patch.theme)
          ? patch.theme
          : current.theme,
      arabicFontScale:
        patch.arabicFontScale !== undefined &&
        isArabicFontScale(patch.arabicFontScale)
          ? patch.arabicFontScale
          : current.arabicFontScale,
      timezone:
        patch.timezone !== undefined
          ? sanitizeTimezonePreference(patch.timezone)
          : current.timezone,
      sessionDefaults:
        patch.sessionDefaults !== undefined
          ? sanitizeSessionDefaults(patch.sessionDefaults)
          : current.sessionDefaults,
    };

    await tx
      .insert(userSettings)
      .values({ userId, ...toColumns(next) })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { ...toColumns(next), updatedAt: new Date() },
      });

    return next;
  });
}

/** Reset to the documented defaults and return them. */
export async function resetAccountSettings(
  userId: string,
): Promise<AccountSettings> {
  await getDb().transaction(async (tx) => {
    await lockUserSettingsRow(tx, userId);
    await tx
      .insert(userSettings)
      .values({ userId, ...toColumns(DEFAULT_ACCOUNT_SETTINGS) })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { ...toColumns(DEFAULT_ACCOUNT_SETTINGS), updatedAt: new Date() },
      });
  });
  return DEFAULT_ACCOUNT_SETTINGS;
}
