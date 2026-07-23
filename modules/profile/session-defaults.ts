/**
 * Learner-editable session defaults (PRODUCT_REQUIREMENTS.md §4.4, Phase 11):
 * questions/session, MC options/question, new items/day, reviews/day —
 * documented defaults 20 · 4 · 10 · 20.
 *
 * Stored as ONE Dexie `settings` row (the durable device-settings authority,
 * Phase 5) and written through the guest-durable write path like every other
 * user-chosen setting. Reads SANITISE per field: any missing/invalid field
 * falls back to its documented default, so a corrupt row can never produce an
 * out-of-range session (e.g. an option count the generator would reject).
 */
import type { SafwaDb } from "@/modules/content/db";
import type { DeviceProfileOptions } from "@/modules/profile/device";
import type { StorageManagerLike } from "@/modules/profile/persistence";
import {
  readSetting,
  SETTING_KEYS,
  writeGuestSetting,
} from "@/modules/profile/settings";
import {
  DEFAULT_SESSION_DEFAULTS,
  sanitizeSessionDefaults,
  SESSION_DEFAULTS_BOUNDS,
  type SessionDefaults,
} from "@/modules/profile/session-defaults-core";

// Re-export the pure model + sanitiser (now living in the leaf module) so every
// existing importer of this file keeps working unchanged.
export {
  DEFAULT_SESSION_DEFAULTS,
  sanitizeSessionDefaults,
  SESSION_DEFAULTS_BOUNDS,
  type SessionDefaults,
};

/** Read the effective session defaults (sanitised; absent row = documented). */
export async function readSessionDefaults(
  db: SafwaDb,
): Promise<SessionDefaults> {
  return sanitizeSessionDefaults(
    await readSetting(db, SETTING_KEYS.sessionDefaults),
  );
}

/**
 * Persist user-chosen session defaults durably (guest action: Dexie write +
 * durable guest state). Values are sanitised BEFORE writing so the stored row
 * is always valid.
 */
export async function persistSessionDefaults(
  db: SafwaDb,
  value: SessionDefaults,
  storage?: StorageManagerLike,
  options: DeviceProfileOptions = {},
): Promise<SessionDefaults> {
  const sanitized = sanitizeSessionDefaults(value);
  await writeGuestSetting(
    db,
    SETTING_KEYS.sessionDefaults,
    sanitized,
    storage,
    options,
  );
  return sanitized;
}
