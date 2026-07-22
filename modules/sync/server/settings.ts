/**
 * Phase 16 — account settings sync (§23). Only a fixed allow-list of
 * account-safe learner settings is persisted, each key validated against its
 * own shape/bounds before it touches `user_settings`. Unknown keys and invalid
 * values are rejected (`invalid_setting_key`) + audited — never blindly stored.
 *
 * Semantics: ACCOUNT-WINS. The server row is authoritative after reconciliation;
 * within a single push batch, the latest client `updatedAt` for a key wins
 * (deterministic). All accepted keys are merged into ONE upsert of the single
 * per-account `user_settings` row, bumping the account cursor once.
 *
 * NEVER synced: secrets, auth/session data, device-ephemeral UI state, live
 * session state, guest identity — those keys are simply absent from the
 * allow-list, so they can never be persisted here (§23).
 *
 * `server-only`.
 */
import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";
import { APP_THEMES } from "@/lib/preferences/app-theme";
import { ARABIC_FONT_SCALES } from "@/lib/preferences/arabic-font-scale";
import { SESSION_DEFAULTS_BOUNDS } from "@/modules/profile/session-defaults";
import {
  isRecoverableReason,
  SYNC_BOUNDS,
  type SyncItemResult,
  type SyncReasonCode,
  type WireSetting,
} from "@/modules/sync/protocol";

import { writeSyncAudit } from "./audit";
import { currentAccountCursor, nextAccountCursor } from "./cursor";

export type SettingsSyncOptions = {
  correlationId?: string;
};

export type SettingsSyncResult = {
  results: SyncItemResult[];
  serverCursor: number;
};

/** A validated partial update to the user_settings row. */
type SettingApplication = Partial<typeof userSettings.$inferInsert>;

const THEME_VALUES = new Set<string>(APP_THEMES);
const FONT_SCALE_VALUES = new Set<string>(Object.keys(ARABIC_FONT_SCALES));
// The wire schema already bounds timezoneName to this; re-use the single
// canonical bound so the two validation layers can never disagree.
const MAX_TIMEZONE_NAME_LENGTH = SYNC_BOUNDS.maxTimezoneLength;

function intInBounds(
  value: unknown,
  bounds: { min: number; max: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
  );
}

/**
 * Validate a single account setting into a column update, or `null` if the key
 * is not on the allow-list or the value fails its shape/bounds. This is the
 * ONLY place a wire setting becomes a persisted column — no key reaches
 * `user_settings` without passing here.
 */
function validateSetting(
  key: string,
  value: unknown,
): SettingApplication | null {
  switch (key) {
    case "theme":
      return typeof value === "string" && THEME_VALUES.has(value)
        ? { theme: value }
        : null;
    case "arabicFontScale":
      return typeof value === "string" && FONT_SCALE_VALUES.has(value)
        ? { arabicFontScale: value }
        : null;
    case "timezone": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
      }
      const { mode, name } = value as { mode?: unknown; name?: unknown };
      if (mode === "browser") {
        return { timezoneMode: "browser", timezoneName: null };
      }
      if (mode === "iana") {
        return typeof name === "string" &&
          name.length > 0 &&
          name.length <= MAX_TIMEZONE_NAME_LENGTH
          ? { timezoneMode: "iana", timezoneName: name }
          : null;
      }
      return null;
    }
    case "questionCount":
      return intInBounds(value, SESSION_DEFAULTS_BOUNDS.questionCount)
        ? { questionCount: value }
        : null;
    case "optionCount":
      return intInBounds(value, SESSION_DEFAULTS_BOUNDS.optionCount)
        ? { optionCount: value }
        : null;
    case "dailyNewTarget":
      return intInBounds(value, SESSION_DEFAULTS_BOUNDS.newPerDay)
        ? { dailyNewTarget: value }
        : null;
    case "dailyReviewTarget":
      return intInBounds(value, SESSION_DEFAULTS_BOUNDS.reviewsPerDay)
        ? { dailyReviewTarget: value }
        : null;
    default:
      return null; // unknown key — never blindly persisted (§23)
  }
}

/** The account-safe setting keys this server persists (for the client + docs). */
export const SYNCABLE_SETTING_KEYS = [
  "theme",
  "arabicFontScale",
  "timezone",
  "questionCount",
  "optionCount",
  "dailyNewTarget",
  "dailyReviewTarget",
] as const;
export type SyncableSettingKey = (typeof SYNCABLE_SETTING_KEYS)[number];

type UserSettingsRow = typeof userSettings.$inferSelect;

/**
 * Extract each syncable setting's current value from the persisted columnar
 * `user_settings` row — the READ counterpart of `validateSetting`. Keyed by
 * `SyncableSettingKey` so the compiler enforces that every syncable key has an
 * extractor (the single source of truth for the pull side; see pull.ts). Adding
 * a key to `SYNCABLE_SETTING_KEYS` fails the build until an extractor is added.
 */
const SETTING_VALUE_EXTRACTORS: Record<
  SyncableSettingKey,
  (row: UserSettingsRow) => unknown
> = {
  theme: (row) => row.theme,
  arabicFontScale: (row) => row.arabicFontScale,
  timezone: (row) =>
    row.timezoneMode === "iana"
      ? { mode: "iana", name: row.timezoneName }
      : { mode: "browser" },
  questionCount: (row) => row.questionCount,
  optionCount: (row) => row.optionCount,
  dailyNewTarget: (row) => row.dailyNewTarget,
  dailyReviewTarget: (row) => row.dailyReviewTarget,
};

/** The syncable settings of a `user_settings` row as `{key, value}` pairs. */
export function extractSyncableSettings(
  row: UserSettingsRow,
): { key: SyncableSettingKey; value: unknown }[] {
  return SYNCABLE_SETTING_KEYS.map((key) => ({
    key,
    value: SETTING_VALUE_EXTRACTORS[key](row),
  }));
}

function reject(item: WireSetting, reasonCode: SyncReasonCode): SyncItemResult {
  return {
    itemId: item.key,
    itemKind: "setting",
    status: "rejected",
    reasonCode,
    duplicate: false,
    recoverable: isRecoverableReason(reasonCode),
  };
}

/**
 * Apply a batch of account settings (account-wins). Validates each key, merges
 * the accepted ones into one upsert of the per-account row, and bumps the
 * account cursor once. Returns one result per submitted setting.
 */
export async function syncSettingsBatch(
  userId: string,
  settings: WireSetting[],
  options: SettingsSyncOptions = {},
): Promise<SettingsSyncResult> {
  const db = getDb();

  // Deterministic within-batch resolution: for a repeated key, the latest
  // client updatedAt wins (account-wins across devices is server authority).
  const latestByKey = new Map<string, WireSetting>();
  for (const setting of settings) {
    const prev = latestByKey.get(setting.key);
    if (!prev || setting.updatedAt >= prev.updatedAt) {
      latestByKey.set(setting.key, setting);
    }
  }

  const results: SyncItemResult[] = [];
  const merged: SettingApplication = {};
  const acceptedKeys: string[] = [];
  const auditsToWrite: string[] = [];

  for (const setting of settings) {
    // A superseded duplicate (older updatedAt) is accepted as an idempotent
    // no-op — the winning one carries the value.
    const winner = latestByKey.get(setting.key);
    if (winner !== setting) {
      results.push({
        itemId: setting.key,
        itemKind: "setting",
        status: "duplicate",
        reasonCode: "duplicate",
        duplicate: true,
        recoverable: false,
      });
      continue;
    }
    const application = validateSetting(setting.key, setting.value);
    if (!application) {
      auditsToWrite.push(setting.key);
      results.push(reject(setting, "invalid_setting_key"));
      continue;
    }
    Object.assign(merged, application);
    acceptedKeys.push(setting.key);
    results.push({
      itemId: setting.key,
      itemKind: "setting",
      status: "accepted",
      reasonCode: "accepted",
      duplicate: false,
      recoverable: false,
    });
  }

  if (acceptedKeys.length === 0) {
    // Still audit the invalid keys (out of band), then return unchanged cursor.
    for (const key of auditsToWrite) {
      await writeSyncAudit(db, {
        userId,
        itemKind: "setting",
        itemId: key,
        reasonCode: "invalid_setting_key",
        severity: "warning",
        correlationId: options.correlationId,
      });
    }
    const serverCursor = await currentAccountCursor(db, userId);
    return { results, serverCursor };
  }

  try {
    const cursor = await db.transaction(async (tx) => {
      // Serialise settings writes for this account (single row).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${userId}:settings`}), 0)`,
      );
      const seq = await nextAccountCursor(tx, userId);
      await tx
        .insert(userSettings)
        .values({ userId, ...merged, lastSyncSeq: seq })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { ...merged, lastSyncSeq: seq, updatedAt: new Date() },
        });
      for (const key of auditsToWrite) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "setting",
          itemId: key,
          reasonCode: "invalid_setting_key",
          severity: "warning",
          correlationId: options.correlationId,
        });
      }
      return seq;
    });
    return { results, serverCursor: cursor };
  } catch (error) {
    // Isolate a settings-transaction abort (lock timeout, transient DB error)
    // to recoverable internal_error results for the accepted keys — mirroring
    // ingest.ts/collections.ts — rather than crashing the whole push request.
    console.error(`[sync] settings: transaction aborted`, error);
    const isolated = results.map((result) =>
      result.status === "accepted"
        ? {
            ...result,
            status: "rejected" as const,
            reasonCode: "internal_error" as const,
            recoverable: true,
          }
        : result,
    );
    for (const key of acceptedKeys) {
      await writeSyncAudit(db, {
        userId,
        itemKind: "setting",
        itemId: key,
        reasonCode: "internal_error",
        severity: "critical",
        correlationId: options.correlationId,
      }).catch(() => {});
    }
    const serverCursor = await currentAccountCursor(db, userId);
    return { results: isolated, serverCursor };
  }
}
