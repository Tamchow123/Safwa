import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import {
  getOrCreateDeviceProfile,
  peekDeviceProfile,
} from "@/modules/profile/device";

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-device-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
});

describe("device profile", () => {
  it("is lazy: no profile row exists until something creates one", async () => {
    expect(await peekDeviceProfile(db)).toBeNull();
    expect(await db.profile.count()).toBe(0);
  });

  it("creates the profile on first use with the injected uuid and clock", async () => {
    const profile = await getOrCreateDeviceProfile(db, {
      now: () => 1234,
      randomUUID: () => "test-uuid-1",
    });
    expect(profile).toEqual({
      key: "device",
      deviceId: "test-uuid-1",
      createdAt: 1234,
      persistenceRequestedAt: null,
      persistenceGranted: null,
    });
    expect(await peekDeviceProfile(db)).toEqual(profile);
  });

  it("is stable: repeated calls return the same device_id and mint once", async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce("first-uuid")
      .mockReturnValue("second-uuid");
    const first = await getOrCreateDeviceProfile(db, { randomUUID });
    const second = await getOrCreateDeviceProfile(db, { randomUUID });
    expect(second.deviceId).toBe("first-uuid");
    expect(second).toEqual(first);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(await db.profile.count()).toBe(1);
  });

  it("concurrent creation races resolve to a single identity", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreateDeviceProfile(db)),
    );
    const ids = new Set(results.map((profile) => profile.deviceId));
    expect(ids.size).toBe(1);
    expect(await db.profile.count()).toBe(1);
  });

  it("defaults to a well-formed random UUID", async () => {
    const profile = await getOrCreateDeviceProfile(db);
    expect(profile.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
