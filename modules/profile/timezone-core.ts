/**
 * PURE timezone-preference model + sanitiser (Phase 12). Split out of
 * `modules/profile/timezone.ts` (which also holds the Dexie-backed read/persist
 * and clock-resolver functions that import `modules/profile/settings.ts`) so
 * callers needing only the pure preference type + sanitiser — the sync mapping
 * (`modules/sync/client/settings-sync.ts`) and the server account-settings
 * surface — can import it without dragging in the settings module and forming an
 * import cycle. No Dexie, no settings, no server-only imports.
 */

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
 * Validation is by CONSTRUCTION (Intl.DateTimeFormat throws on unknown zones),
 * never a hand-maintained list. Blank strings are rejected outright.
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
 * The browser's own IANA zone, falling back to UTC when the environment does not
 * expose a usable resolved zone (the same safe fallback the study paths use).
 */
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Coerce an unknown stored value into a valid preference. Anything that is not a
 * well-formed `{ mode: "iana", timezone: <valid zone> }` — including a zone this
 * environment no longer recognises — falls back to browser detection. An invalid
 * stored row can therefore never poison future event stamping.
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
