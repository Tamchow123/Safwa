/**
 * Dexie-backed settings persistence (Phase 5). The Dexie `settings` store
 * is the DURABLE authority for device settings; localStorage remains a
 * synchronous mirror so first paint and hydration stay flash-free (React
 * cannot read IndexedDB synchronously). Writes go to both; reads at app
 * start reconcile the mirror from Dexie, migrating any pre-Phase-5
 * localStorage-only value into Dexie so it is never dropped.
 */
import type { SafwaDb, SettingRecord } from "@/modules/content/db";
import {
  ensureDurableGuestState,
  type StorageManagerLike,
} from "@/modules/profile/persistence";
import type { DeviceProfileOptions } from "@/modules/profile/device";
import {
  APP_THEME_STORAGE_KEY,
  isAppTheme,
  type AppTheme,
} from "@/lib/preferences/app-theme";
import {
  ARABIC_FONT_SCALE_STORAGE_KEY,
  DEFAULT_ARABIC_FONT_SCALE,
  isArabicFontScale,
  writeArabicFontScale,
  type ArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";

export const SETTING_KEYS = {
  arabicFontScale: "arabic-font-scale",
  registerPromptDismissed: "register-prompt-dismissed",
  theme: "theme",
} as const;

export async function readSetting(db: SafwaDb, key: string): Promise<unknown> {
  const record = await db.settings.get(key);
  return record?.value;
}

export async function writeSetting(
  db: SafwaDb,
  key: string,
  value: unknown,
  now: () => number = Date.now,
): Promise<void> {
  const record: SettingRecord = { key, value, updatedAt: now() };
  await db.settings.put(record);
}

/**
 * Write a setting as an explicit GUEST action: persists the value and
 * ensures durable guest state (lazy device profile + storage-persist
 * request). This is the write path user-triggered settings changes use;
 * silent internal writes use writeSetting directly.
 *
 * Both halves start AT the user action, concurrently — the durability
 * boundary (profile mint + persist request) is never gated behind the
 * awaited setting write, so a tab closing moments after the action cannot
 * skip the persist request merely because the setting write was still in
 * flight. Each half self-heals if the other is cut off: an unlanded
 * setting is restored from the synchronous mirror on next load
 * (syncArabicFontScale), and the boundary re-arms on every subsequent
 * guest action. The residual window — the browser dying before either
 * in-flight IndexedDB transaction commits — is irreducible for an
 * asynchronous storage API and is covered by those same recovery paths.
 */
export async function writeGuestSetting(
  db: SafwaDb,
  key: string,
  value: unknown,
  storage?: StorageManagerLike,
  options: DeviceProfileOptions = {},
): Promise<void> {
  await Promise.all([
    writeSetting(db, key, value, options.now ?? Date.now),
    ensureDurableGuestState(db, storage, options),
  ]);
}

/**
 * Result of reconciling the Arabic font scale at app start. `restoreMirror`
 * is true when Dexie holds the authoritative value but the mirror was
 * absent or invalid — only then may the caller write the mirror back. When
 * NEITHER store held a value the effective scale is the default and
 * nothing may be written anywhere: an absent setting and an explicitly
 * chosen "default" are distinct states, and a passive page load must not
 * manufacture the latter (it would later be migrated into Dexie and appear
 * in the user's data export as a choice they never made).
 */
export type ArabicFontScaleSyncResult = {
  effective: ArabicFontScale;
  restoreMirror: boolean;
};

/**
 * Resolve the effective Arabic font scale at app start:
 * - Both stores hold valid values that DISAGREE → the mirror wins and is
 *   healed into Dexie. Every writer updates the synchronous mirror first
 *   and the durable copy second (setScale/persistArabicFontScale), so a
 *   startup divergence can only mean a user choice whose fire-and-forget
 *   Dexie write failed or was cut off by the tab closing — the mirror is
 *   the newer value. (Revisit when account settings sync (Phase 15+) adds
 *   a Dexie writer that does not go through the mirror.)
 * - Dexie has a valid value and the mirror is absent/invalid → Dexie wins
 *   (`restoreMirror: true`; a cleared mirror is restored from the durable
 *   copy).
 * - Dexie is empty but the mirror holds ANY valid value — including an
 *   explicitly chosen "default" — → one-time migration INTO Dexie. A
 *   missing key and the stored value "default" are distinct: only a
 *   genuinely absent/invalid mirror is treated as "never set".
 * - Neither → default, nothing written, `restoreMirror: false`.
 *
 * All writes here are silent (no profile mint, no permission-prompting
 * persist request on page load). The mirror is only READ here; writing it
 * back when `restoreMirror` is set is the caller's job
 * (reconcileArabicFontScaleFromDb), which must first check that no user
 * write happened while this read was in flight — a mirror write here would
 * bypass that staleness guard.
 */
export async function syncArabicFontScale(
  db: SafwaDb,
  mirror: Pick<Storage, "getItem">,
  now: () => number = Date.now,
): Promise<ArabicFontScaleSyncResult> {
  const stored = await readSetting(db, SETTING_KEYS.arabicFontScale);
  let rawMirror: string | null = null;
  try {
    rawMirror = mirror.getItem(ARABIC_FONT_SCALE_STORAGE_KEY);
  } catch {
    rawMirror = null;
  }
  if (isArabicFontScale(stored)) {
    if (isArabicFontScale(rawMirror)) {
      if (rawMirror !== stored) {
        await writeSetting(db, SETTING_KEYS.arabicFontScale, rawMirror, now);
        return { effective: rawMirror, restoreMirror: false };
      }
      return { effective: stored, restoreMirror: false };
    }
    return { effective: stored, restoreMirror: true };
  }
  if (isArabicFontScale(rawMirror)) {
    await writeSetting(db, SETTING_KEYS.arabicFontScale, rawMirror, now);
    return { effective: rawMirror, restoreMirror: false };
  }
  return { effective: DEFAULT_ARABIC_FONT_SCALE, restoreMirror: false };
}

/**
 * Result of reconciling the theme at app start. `restoreMirror` is true
 * when Dexie holds the authoritative value but the mirror (next-themes'
 * localStorage key) was absent or invalid — the caller must push the value
 * back through next-themes' setTheme so the class and mirror are restored.
 */
export type ThemeSyncResult = {
  effective: AppTheme | null;
  restoreMirror: boolean;
};

/**
 * Resolve the effective theme at app start. Identical policy to
 * syncArabicFontScale — Dexie is the durable authority, the synchronous
 * mirror (here: next-themes' own localStorage key, which its inline script
 * reads before first paint) wins on divergence because every user theme
 * change writes the mirror synchronously (next-themes setTheme) before the
 * fire-and-forget durable write. All writes here are silent: no profile
 * mint, no persist request on page load. The mirror is only read; pushing
 * a restored value back into it is the caller's job via next-themes.
 */
export async function syncTheme(
  db: SafwaDb,
  mirror: Pick<Storage, "getItem">,
  now: () => number = Date.now,
): Promise<ThemeSyncResult> {
  const stored = await readSetting(db, SETTING_KEYS.theme);
  let rawMirror: string | null = null;
  try {
    rawMirror = mirror.getItem(APP_THEME_STORAGE_KEY);
  } catch {
    rawMirror = null;
  }
  if (isAppTheme(stored)) {
    if (isAppTheme(rawMirror)) {
      if (rawMirror !== stored) {
        await writeSetting(db, SETTING_KEYS.theme, rawMirror, now);
        return { effective: rawMirror, restoreMirror: false };
      }
      return { effective: stored, restoreMirror: false };
    }
    return { effective: stored, restoreMirror: true };
  }
  if (isAppTheme(rawMirror)) {
    await writeSetting(db, SETTING_KEYS.theme, rawMirror, now);
    return { effective: rawMirror, restoreMirror: false };
  }
  return { effective: null, restoreMirror: false };
}

/**
 * Persist a user-chosen theme durably (Dexie) as a guest action. next-themes
 * has already written the synchronous mirror and applied the class by the
 * time this runs.
 */
export async function persistTheme(
  db: SafwaDb,
  theme: AppTheme,
  storage?: StorageManagerLike,
  options: DeviceProfileOptions = {},
): Promise<void> {
  await writeGuestSetting(db, SETTING_KEYS.theme, theme, storage, options);
}

/**
 * Persist a user-chosen Arabic font scale durably (Dexie + mirror) as a
 * guest action. The caller is responsible for the synchronous UI update.
 */
export async function persistArabicFontScale(
  db: SafwaDb,
  scale: ArabicFontScale,
  mirror: Pick<Storage, "setItem">,
  storage?: StorageManagerLike,
  options: DeviceProfileOptions = {},
): Promise<void> {
  writeArabicFontScale(mirror, scale);
  await writeGuestSetting(
    db,
    SETTING_KEYS.arabicFontScale,
    scale,
    storage,
    options,
  );
}

/** True when the guest has dismissed the register prompt. */
export async function isRegisterPromptDismissed(db: SafwaDb): Promise<boolean> {
  return (await readSetting(db, SETTING_KEYS.registerPromptDismissed)) === true;
}

/** Record a register-prompt dismissal (durable guest action). */
export async function dismissRegisterPrompt(
  db: SafwaDb,
  storage?: StorageManagerLike,
  options: DeviceProfileOptions = {},
): Promise<void> {
  await writeGuestSetting(
    db,
    SETTING_KEYS.registerPromptDismissed,
    true,
    storage,
    options,
  );
}
