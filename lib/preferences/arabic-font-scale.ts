/**
 * Arabic text-size preference — pure, storage-agnostic logic.
 *
 * Persistence is local storage for now (versioned, namespaced key); the
 * functions take the storage/root objects as parameters so the persistence
 * layer can migrate (e.g. to Dexie in Phase 5, account settings in Phase 15)
 * without touching consumers.
 */

export const ARABIC_FONT_SCALE_STORAGE_KEY = "safwa:settings:arabic-font-scale";

export const ARABIC_FONT_SCALES = {
  small: 0.9,
  default: 1,
  large: 1.2,
} as const;

export type ArabicFontScale = keyof typeof ARABIC_FONT_SCALES;

export const DEFAULT_ARABIC_FONT_SCALE: ArabicFontScale = "default";

export const ARABIC_FONT_SCALE_LABELS: Record<ArabicFontScale, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
};

export const ARABIC_FONT_SCALE_CSS_PROPERTY = "--arabic-font-scale";

export function isArabicFontScale(value: unknown): value is ArabicFontScale {
  return typeof value === "string" && Object.hasOwn(ARABIC_FONT_SCALES, value);
}

/** Parse a stored value, falling back safely to the default. */
export function parseArabicFontScale(value: unknown): ArabicFontScale {
  return isArabicFontScale(value) ? value : DEFAULT_ARABIC_FONT_SCALE;
}

export function readArabicFontScale(
  storage: Pick<Storage, "getItem">,
): ArabicFontScale {
  try {
    return parseArabicFontScale(storage.getItem(ARABIC_FONT_SCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_ARABIC_FONT_SCALE;
  }
}

export function writeArabicFontScale(
  storage: Pick<Storage, "setItem">,
  scale: ArabicFontScale,
): void {
  try {
    storage.setItem(ARABIC_FONT_SCALE_STORAGE_KEY, scale);
  } catch {
    // Storage may be unavailable (private mode, quota); the in-memory value
    // still applies for the session.
  }
}

/** Apply the preference as a CSS custom property on the document root. */
export function applyArabicFontScale(
  root: Pick<HTMLElement, "style">,
  scale: ArabicFontScale,
): void {
  root.style.setProperty(
    ARABIC_FONT_SCALE_CSS_PROPERTY,
    String(ARABIC_FONT_SCALES[scale]),
  );
}
