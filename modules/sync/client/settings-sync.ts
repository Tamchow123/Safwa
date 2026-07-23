/**
 * Phase 16 — map a LOCAL Dexie setting to zero or more SERVER-syncable wire
 * settings (§23, EXT-F2). The local `settings` store uses kebab-case keys and
 * app-shaped values (arabic-font-scale, theme, timezone preference, a bundled
 * session-defaults blob, plus non-syncable internal keys); the server persists a
 * fixed allow-list of camelCase keys with column-shaped values
 * (`modules/sync/server/settings.ts` `SYNCABLE_SETTING_KEYS`, validated by
 * `validateSetting`). This is the SINGLE client-side translation point between
 * the two, mirroring the server's own `AccountSettings <-> columns` mapping in
 * `modules/auth/account-settings.ts`.
 *
 * A key not on the server allow-list (e.g. `register-prompt-dismissed`, or an
 * internal key like `study:client-sequence`) maps to NOTHING and is never
 * enqueued — the mapping IS the syncability gate. A malformed value for a
 * syncable key is dropped (theme/font) or sanitised to a valid preference
 * (timezone/session-defaults) so only account-safe values ever cross the wire.
 * Pure — no Dexie, no server-only.
 */
import { isAppTheme } from "@/lib/preferences/app-theme";
import { isArabicFontScale } from "@/lib/preferences/arabic-font-scale";
import { sanitizeSessionDefaults } from "@/modules/profile/session-defaults-core";
import { SETTING_KEYS } from "@/modules/profile/setting-keys";
import { sanitizeTimezonePreference } from "@/modules/profile/timezone-core";
import type { WireSetting } from "@/modules/sync/protocol";

/**
 * Translate one local setting write to the server wire settings it produces.
 * Returns `[]` for a non-syncable key or an invalid theme/font value.
 */
export function mapLocalSettingToWire(
  localKey: string,
  value: unknown,
  updatedAt: number,
): WireSetting[] {
  switch (localKey) {
    case SETTING_KEYS.arabicFontScale:
      // Server key `arabicFontScale`; value is the scale-key string.
      return isArabicFontScale(value)
        ? [{ key: "arabicFontScale", value, updatedAt }]
        : [];
    case SETTING_KEYS.theme:
      return isAppTheme(value) ? [{ key: "theme", value, updatedAt }] : [];
    case SETTING_KEYS.timezone: {
      // Local `{mode:"iana", timezone}` -> server `{mode:"iana", name}`.
      const tz = sanitizeTimezonePreference(value);
      const wireValue =
        tz.mode === "iana"
          ? { mode: "iana", name: tz.timezone }
          : { mode: "browser" };
      return [{ key: "timezone", value: wireValue, updatedAt }];
    }
    case SETTING_KEYS.sessionDefaults: {
      // One local blob -> four server keys (matches account-settings.toColumns).
      const sd = sanitizeSessionDefaults(value);
      return [
        { key: "questionCount", value: sd.questionCount, updatedAt },
        { key: "optionCount", value: sd.optionCount, updatedAt },
        { key: "dailyNewTarget", value: sd.newPerDay, updatedAt },
        { key: "dailyReviewTarget", value: sd.reviewsPerDay, updatedAt },
      ];
    }
    default:
      // register-prompt-dismissed and every internal key: not account-safe.
      return [];
  }
}
