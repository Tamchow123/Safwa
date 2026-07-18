/**
 * Anonymous local device profile. The profile is a single row in the Dexie
 * `profile` store holding a random `device_id`. It is created LAZILY — no
 * identity exists until the first durable learner-state write needs one —
 * and it never leaves the device (no server communication in this module).
 *
 * BROWSER-ONLY at runtime (IndexedDB); tests use fake-indexeddb.
 */
import type { DeviceProfileRecord, SafwaDb } from "@/modules/content/db";

export const DEVICE_PROFILE_KEY = "device" as const;

export type DeviceProfileOptions = {
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Injected UUID source for deterministic tests. */
  randomUUID?: () => string;
};

function defaultRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/** Read the device profile without creating one. Null when none exists. */
export async function peekDeviceProfile(
  db: SafwaDb,
): Promise<DeviceProfileRecord | null> {
  return (await db.profile.get(DEVICE_PROFILE_KEY)) ?? null;
}

/**
 * Build a fresh device-profile record for a given id, WITHOUT writing it. Lets a
 * caller create the profile inside another store's transaction (e.g. atomically
 * with the first durable learner-state write) so a failed write leaves no
 * orphaned identity. The profile shape stays owned here, not at the call site.
 */
export function newDeviceProfile(
  deviceId: string,
  now: number,
): DeviceProfileRecord {
  return {
    key: DEVICE_PROFILE_KEY,
    deviceId,
    createdAt: now,
    persistenceRequestedAt: null,
    persistenceGranted: null,
  };
}

/**
 * Get the device profile, minting it on first use. The check-then-add runs
 * in a readwrite transaction on the profile store, so concurrent callers
 * (including other tabs) serialize and every caller observes the same
 * single identity — the device_id is stable once created.
 */
export async function getOrCreateDeviceProfile(
  db: SafwaDb,
  options: DeviceProfileOptions = {},
): Promise<DeviceProfileRecord> {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  return db.transaction("rw", db.profile, async () => {
    const existing = await db.profile.get(DEVICE_PROFILE_KEY);
    if (existing) return existing;
    const created: DeviceProfileRecord = {
      key: DEVICE_PROFILE_KEY,
      deviceId: randomUUID(),
      createdAt: now(),
      persistenceRequestedAt: null,
      persistenceGranted: null,
    };
    await db.profile.add(created);
    return created;
  });
}
