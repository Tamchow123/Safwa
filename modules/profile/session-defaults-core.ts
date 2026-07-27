/**
 * PURE session-defaults model + sanitiser (PRODUCT_REQUIREMENTS.md §4.4). Split
 * out of `modules/profile/session-defaults.ts` (which also holds the Dexie-backed
 * read/persist functions that import `modules/profile/settings.ts`) so callers
 * needing only the pure sanitiser — the sync mapping
 * (`modules/sync/client/settings-sync.ts`) and the server account-settings
 * surface — can import it without dragging in the settings module and forming an
 * import cycle. No Dexie, no settings, no server-only imports.
 */
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
