/**
 * Timezone preference (Phase 12, PRODUCT_REQUIREMENTS.md §6 / DATA_MODEL.md
 * §5-6). The learner may keep the browser-detected IANA zone (the default) or
 * pin an explicit IANA zone. The preference decides how FUTURE attempts and
 * review events stamp their immutable event-time fields
 * (`local_date_at_event`, offset, source) — recorded history is never
 * re-keyed; a timezone change affects future events only.
 *
 * The ONE effective-clock resolver lives here: every study path builds its
 * `AttemptClock` through `resolveEffectiveClock`/`readEffectiveClock` so the
 * clock carries the honest `timezoneSource` (`browser_detected` vs
 * `user_setting`). Stored as one Dexie `settings` row via the guest-durable
 * write path, sanitised on read AND before write like every other setting —
 * a corrupt/invalid stored value falls back safely to browser detection.
 */
import type { SafwaDb } from "@/modules/content/db";
import type { DeviceProfileOptions } from "@/modules/profile/device";
import type { StorageManagerLike } from "@/modules/profile/persistence";
import {
  readSetting,
  SETTING_KEYS,
  writeGuestSetting,
} from "@/modules/profile/settings";
import type { AttemptClock } from "@/modules/study-engine/attempts";

/**
 * Browser-detected (default) or an explicit IANA zone. The two modes are
 * structurally distinct — never an ambiguous empty string.
 */
export type TimezonePreference =
  { mode: "browser" } | { mode: "iana"; timezone: string };

export const DEFAULT_TIMEZONE_PREFERENCE: TimezonePreference = {
  mode: "browser",
};

/**
 * Is this string a timezone identifier `Intl` can actually format with?
 * Validation is by CONSTRUCTION (Intl.DateTimeFormat throws on unknown
 * zones), never a hand-maintained list. Blank strings are rejected outright.
 */
export function isValidTimezone(timezone: string): boolean {
  if (timezone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser's own IANA zone, falling back to UTC when the environment does
 * not expose a usable resolved zone (the same safe fallback the study paths
 * have always used).
 */
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Coerce an unknown stored value into a valid preference. Anything that is
 * not a well-formed `{ mode: "iana", timezone: <valid zone> }` — including a
 * zone this environment no longer recognises — falls back to browser
 * detection. An invalid stored row can therefore never poison future event
 * stamping.
 */
export function sanitizeTimezonePreference(value: unknown): TimezonePreference {
  if (typeof value === "object" && value !== null) {
    const raw = value as { mode?: unknown; timezone?: unknown };
    if (raw.mode === "browser") return { mode: "browser" };
    if (
      raw.mode === "iana" &&
      typeof raw.timezone === "string" &&
      isValidTimezone(raw.timezone)
    ) {
      return { mode: "iana", timezone: raw.timezone };
    }
  }
  return DEFAULT_TIMEZONE_PREFERENCE;
}

/** Read the effective preference (sanitised; absent row = browser mode). */
export async function readTimezonePreference(
  db: SafwaDb,
): Promise<TimezonePreference> {
  return sanitizeTimezonePreference(
    await readSetting(db, SETTING_KEYS.timezone),
  );
}

/**
 * Persist a user-chosen preference durably (guest action: Dexie write +
 * durable guest state). Sanitised BEFORE writing so the stored row is always
 * valid; returns what was actually stored.
 */
export async function persistTimezonePreference(
  db: SafwaDb,
  value: TimezonePreference,
  storage?: StorageManagerLike,
  options: DeviceProfileOptions = {},
): Promise<TimezonePreference> {
  const sanitized = sanitizeTimezonePreference(value);
  await writeGuestSetting(
    db,
    SETTING_KEYS.timezone,
    sanitized,
    storage,
    options,
  );
  return sanitized;
}

/**
 * THE effective-clock resolver (Phase 12 §10.5): browser mode → detected zone
 * + `browser_detected`; explicit valid IANA mode → selected zone +
 * `user_setting`; anything unusable → browser detection (which itself falls
 * back to UTC). Every study path must build its clock through this resolver —
 * never an unconditional browser clock — so recorded events carry the honest
 * `timezoneSource`.
 */
export function resolveEffectiveClock(
  preference: TimezonePreference,
  now: () => number = () => Date.now(),
): AttemptClock {
  if (preference.mode === "iana" && isValidTimezone(preference.timezone)) {
    return {
      now,
      timezone: preference.timezone,
      timezoneSource: "user_setting",
    };
  }
  return {
    now,
    timezone: detectBrowserTimezone(),
    timezoneSource: "browser_detected",
  };
}

/**
 * Read the stored preference and resolve the effective clock in one step —
 * the impure entry point the study runners call ONCE per mounted session
 * (§10.6: the zone is frozen for the session; a settings change applies to
 * sessions started afterwards). An unreadable settings store must not block
 * studying: any read failure falls back to browser detection (the
 * pre-preference behaviour).
 */
export async function readEffectiveClock(db: SafwaDb): Promise<AttemptClock> {
  try {
    return resolveEffectiveClock(await readTimezonePreference(db));
  } catch {
    return resolveEffectiveClock(DEFAULT_TIMEZONE_PREFERENCE);
  }
}

/**
 * The zones offered by the picker: `Intl.supportedValuesOf("timeZone")` when
 * the runtime provides it, always including UTC and the currently detected
 * zone, sorted. The fallback (runtime without `supportedValuesOf`) still
 * offers at least the detected zone and UTC.
 */
export function availableTimezones(): string[] {
  let zones: string[] = [];
  try {
    zones =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [];
  } catch {
    zones = [];
  }
  const set = new Set<string>(zones);
  set.add("UTC");
  const detected = detectBrowserTimezone();
  if (isValidTimezone(detected)) set.add(detected);
  return [...set].sort((a, b) => a.localeCompare(b, "en"));
}
