/**
 * Theme preference — pure, storage-agnostic logic.
 *
 * The theme is applied by next-themes, whose localStorage key acts as the
 * synchronous mirror (it is read by next-themes' inline script before first
 * paint, which an async store like Dexie cannot do). Phase 5 makes Dexie
 * the DURABLE authority for the value; these helpers validate values shared
 * between the two.
 */

/** next-themes' default storageKey (the provider does not override it). */
export const APP_THEME_STORAGE_KEY = "theme";

export const APP_THEMES = ["light", "dark", "system"] as const;

export type AppTheme = (typeof APP_THEMES)[number];

export function isAppTheme(value: unknown): value is AppTheme {
  return (
    typeof value === "string" &&
    (APP_THEMES as readonly string[]).includes(value)
  );
}
