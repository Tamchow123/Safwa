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

/**
 * Force the next-themes mirror to a value (R2-F5). A pulled account setting is
 * server-authoritative (§23 account-wins), so — unlike the startup reconcile,
 * which treats a valid mirror as an interrupted local write and keeps it — the
 * pulled value must OVERWRITE the mirror. next-themes' inline pre-paint script
 * then applies it on the next load. Best-effort (quota/private mode).
 */
export function writeAppThemeMirror(
  storage: Pick<Storage, "setItem">,
  theme: AppTheme,
): void {
  try {
    storage.setItem(APP_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable; the durable Dexie value still applies on reconcile.
  }
}
