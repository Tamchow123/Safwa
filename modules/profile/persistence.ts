/**
 * Durable-storage request for guest state. `navigator.storage.persist()` is
 * requested when the guest first produces durable local state (their
 * "first progress"), never on passive page load — in some browsers
 * (Firefox) the call shows a permission prompt, so it must always follow an
 * explicit user action.
 *
 * KNOWN LIMITATION (documented, see docs/IMPLEMENTATION_PHASES.md Phase 5
 * risks): if the browser denies or ignores the request, IndexedDB remains
 * subject to storage-pressure eviction. The register prompt and the
 * export-my-data safety valve exist for exactly this reason. A denied
 * request is retried on later durable writes because engagement-based
 * heuristics (e.g. Chromium) can grant it later.
 */
import type { DeviceProfileRecord, SafwaDb } from "@/modules/content/db";
import {
  getOrCreateDeviceProfile,
  type DeviceProfileOptions,
} from "@/modules/profile/device";

/** Minimal structural facade over navigator.storage for injection. */
export type StorageManagerLike = {
  persist?: () => Promise<boolean>;
};

/** Resolve the real StorageManager where available (browser only). */
export function defaultStorageManager(): StorageManagerLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.storage;
}

/**
 * DOM event dispatched after a guest action's durability boundary
 * completes. Components whose visibility depends on guest state existing
 * (the register prompt) listen for it so first progress made while they
 * are already mounted surfaces without a navigation or reload.
 */
export const GUEST_STATE_CHANGED_EVENT = "safwa:guest-state-changed";

function notifyGuestStateChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GUEST_STATE_CHANGED_EVENT));
  }
}

/**
 * Coalesces concurrent durability requests per database: near-simultaneous
 * guest actions (e.g. "Reset appearance" writing the theme and the font
 * scale together) must produce ONE storage-persist request, not one
 * permission prompt per write. The entry clears once the request settles,
 * so a denial is retried by the next distinct guest action but never
 * re-prompted within the same one.
 */
const inFlight = new WeakMap<SafwaDb, Promise<DeviceProfileRecord>>();

/**
 * Ensure the guest has durable local state backing: mint the lazy device
 * profile if needed, and request persistent storage unless it is already
 * granted. The request outcome is recorded on the profile row —
 * `persistenceRequestedAt` keeps the FIRST request time, `persistenceGranted`
 * the latest known verdict (null when the API is unavailable or the call
 * failed; a recorded grant is monotonic and cannot be revoked by a racing
 * later verdict). Safe to call on every durable write; it no-ops once
 * granted, concurrent calls coalesce into one request, and every completed
 * call announces itself via GUEST_STATE_CHANGED_EVENT.
 */
export async function ensureDurableGuestState(
  db: SafwaDb,
  storage: StorageManagerLike | undefined = defaultStorageManager(),
  options: DeviceProfileOptions = {},
): Promise<DeviceProfileRecord> {
  const pending = inFlight.get(db);
  if (pending) return pending;
  const request = requestDurableGuestState(db, storage, options);
  inFlight.set(db, request);
  try {
    const profile = await request;
    notifyGuestStateChanged();
    return profile;
  } finally {
    inFlight.delete(db);
  }
}

async function requestDurableGuestState(
  db: SafwaDb,
  storage: StorageManagerLike | undefined,
  options: DeviceProfileOptions,
): Promise<DeviceProfileRecord> {
  const now = options.now ?? Date.now;
  const profile = await getOrCreateDeviceProfile(db, options);
  if (profile.persistenceGranted === true) return profile;
  if (typeof storage?.persist !== "function") return profile;

  let granted: boolean | null = null;
  try {
    granted = await storage.persist();
  } catch {
    // Unavailable/failing persistence API is a non-verdict; guest state
    // still works, only the eviction guarantee is weaker.
    granted = null;
  }
  const requestedAt = now();

  // persist() cannot be awaited inside an IndexedDB transaction (it would
  // auto-commit), so the outcome is merged transactionally afterwards:
  // concurrent callers re-read the row, the FIRST request time wins, a
  // null non-verdict never overwrites a real recorded verdict, and a
  // recorded grant is never downgraded (browsers do not revoke persistence
  // short of the user clearing site data, so a racing `false` can only be
  // an older answer arriving late).
  return db.transaction("rw", db.profile, async () => {
    const current = (await db.profile.get(profile.key)) ?? profile;
    const updated: DeviceProfileRecord = {
      ...current,
      persistenceRequestedAt: current.persistenceRequestedAt ?? requestedAt,
      persistenceGranted:
        current.persistenceGranted === true
          ? true
          : (granted ?? current.persistenceGranted),
    };
    await db.profile.put(updated);
    return updated;
  });
}
