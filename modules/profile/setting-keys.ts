/**
 * The local Dexie `settings` store keys (Phase 5). Extracted to its own leaf
 * module so both the settings persistence layer (`modules/profile/settings.ts`)
 * and the sync mapping (`modules/sync/client/settings-sync.ts`) can import the
 * key names without forming an import cycle. Pure constants — no imports.
 */
export const SETTING_KEYS = {
  arabicFontScale: "arabic-font-scale",
  registerPromptDismissed: "register-prompt-dismissed",
  sessionDefaults: "session-defaults",
  theme: "theme",
  timezone: "timezone",
} as const;
