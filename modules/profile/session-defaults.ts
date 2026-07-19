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
  MAX_OPTION_COUNT,
  MIN_OPTION_COUNT,
} from "@/modules/study-engine/generator";

export type SessionDefaults = {
  /** Questions per session (§4.4 default 20). */
  questionCount: number;
  /** MC options per question (§4.4 default 4). */
  optionCount: number;
  /** New items introduced per day (§4.4 default 10). */
  newPerDay: number;
  /** Review target per day (§4.4 default 20). */
  reviewsPerDay: number;
};

/** The documented §4.4 defaults: 20 questions · 4 options · 10 new · 20 reviews. */
export const DEFAULT_SESSION_DEFAULTS: SessionDefaults = {
  questionCount: 20,
  optionCount: 4,
  newPerDay: 10,
  reviewsPerDay: 20,
};

/** Inclusive bounds per field (option count mirrors the generator's bounds). */
export const SESSION_DEFAULTS_BOUNDS: Record<
  keyof SessionDefaults,
  { min: number; max: number }
> = {
  questionCount: { min: 1, max: 100 },
  optionCount: { min: MIN_OPTION_COUNT, max: MAX_OPTION_COUNT },
  newPerDay: { min: 0, max: 100 },
  reviewsPerDay: { min: 0, max: 500 },
};

function sanitizeField(field: keyof SessionDefaults, value: unknown): number {
  const bounds = SESSION_DEFAULTS_BOUNDS[field];
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
  ) {
    return value;
  }
  return DEFAULT_SESSION_DEFAULTS[field];
}

/** Coerce an unknown stored value into valid session defaults, per field. */
export function sanitizeSessionDefaults(value: unknown): SessionDefaults {
  const raw = (value ?? {}) as Partial<Record<keyof SessionDefaults, unknown>>;
  return {
    questionCount: sanitizeField("questionCount", raw.questionCount),
    optionCount: sanitizeField("optionCount", raw.optionCount),
    newPerDay: sanitizeField("newPerDay", raw.newPerDay),
    reviewsPerDay: sanitizeField("reviewsPerDay", raw.reviewsPerDay),
  };
}

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
