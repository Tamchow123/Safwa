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
import {
  sanitizeSessionDefaults,
  type SessionDefaults,
} from "@/modules/profile/session-defaults-core";
import { SETTING_KEYS } from "@/modules/profile/setting-keys";
import {
  sanitizeTimezonePreference,
  type TimezonePreference,
} from "@/modules/profile/timezone-core";
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

/** A LOCAL setting row to upsert when applying pulled server settings. */
export type LocalSettingUpsert = {
  key: string;
  value: unknown;
  updatedAt: number;
};

/** The inverse of the pull: what a pulled server settings page maps to locally. */
export type FoldedPulledSettings = {
  /** Direct 1:1 local upserts (arabicFontScale/theme/timezone). */
  directPuts: LocalSettingUpsert[];
  /** The merged local session-defaults blob, or null if none of its keys arrived. */
  sessionDefaults: SessionDefaults | null;
  /** The newest updatedAt across the session-defaults keys that arrived. */
  sessionDefaultsUpdatedAt: number;
};

/** Convert a server timezone wire value `{mode,name}` to the local preference. */
function wireTimezoneToLocal(value: unknown): TimezonePreference {
  if (typeof value === "object" && value !== null) {
    const raw = value as { mode?: unknown; name?: unknown };
    if (raw.mode === "iana" && typeof raw.name === "string") {
      // sanitize validates the zone; an unknown zone falls back to browser.
      return sanitizeTimezonePreference({ mode: "iana", timezone: raw.name });
    }
  }
  return { mode: "browser" };
}

/**
 * Fold a pulled server-settings page into the LOCAL representation (§23,
 * EXT-F2) — the inverse of `mapLocalSettingToWire`. The 1:1 keys become direct
 * local upserts under their kebab key (with the timezone value reshaped); the
 * four session-defaults keys are MERGED (each present field applied over the
 * caller-supplied current blob, so a partial page only changes the fields that
 * arrived) into one local `session-defaults` row. Unknown/non-syncable server
 * keys are ignored. Pure — the caller reads the current session defaults and
 * performs the Dexie writes.
 *
 * SESSION-DEFAULTS INVARIANT: the merge-over-current model is correct because
 * the server emits ALL of the session-defaults keys together whenever the
 * settings row is in a pull page (modules/sync/server/pull.ts's
 * `extractSyncableSettings` maps unconditionally over every syncable key), so a
 * true partial subset never occurs and no genuinely-changed field is ever
 * silently retained as stale. If that server emission ever becomes field-partial,
 * this merge base must be revisited.
 */
export function foldPulledSettings(
  wireSettings: readonly LocalSettingUpsert[],
  currentSessionDefaults: SessionDefaults,
): FoldedPulledSettings {
  const directPuts: LocalSettingUpsert[] = [];
  let sd: SessionDefaults | null = null;
  let sdUpdatedAt = 0;
  const patchField = (field: keyof SessionDefaults, s: LocalSettingUpsert) => {
    // Only advance provenance when a field is actually applied — a skipped
    // (non-numeric) value must not bump the row's updatedAt (REL-002).
    if (typeof s.value !== "number") return;
    sd = sd ?? { ...currentSessionDefaults };
    sd[field] = s.value;
    sdUpdatedAt = Math.max(sdUpdatedAt, s.updatedAt);
  };
  for (const s of wireSettings) {
    switch (s.key) {
      case "arabicFontScale":
        // Validate on the way IN too, mirroring the push side, so a malformed or
        // future-version value never lands in the local store (REL-001).
        if (isArabicFontScale(s.value)) {
          directPuts.push({
            key: SETTING_KEYS.arabicFontScale,
            value: s.value,
            updatedAt: s.updatedAt,
          });
        }
        break;
      case "theme":
        if (isAppTheme(s.value)) {
          directPuts.push({
            key: SETTING_KEYS.theme,
            value: s.value,
            updatedAt: s.updatedAt,
          });
        }
        break;
      case "timezone":
        directPuts.push({
          key: SETTING_KEYS.timezone,
          value: wireTimezoneToLocal(s.value),
          updatedAt: s.updatedAt,
        });
        break;
      case "questionCount":
        patchField("questionCount", s);
        break;
      case "optionCount":
        patchField("optionCount", s);
        break;
      case "dailyNewTarget":
        patchField("newPerDay", s);
        break;
      case "dailyReviewTarget":
        patchField("reviewsPerDay", s);
        break;
      default:
        break; // unknown/non-syncable server key — ignore
    }
  }
  return {
    directPuts,
    // Re-sanitise the merged blob so an out-of-range pulled value can never
    // land locally (matches the write-side and read-side sanitisation).
    sessionDefaults: sd ? sanitizeSessionDefaults(sd) : null,
    sessionDefaultsUpdatedAt: sdUpdatedAt,
  };
}
