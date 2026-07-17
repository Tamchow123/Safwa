import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import { peekDeviceProfile } from "@/modules/profile/device";
import { ensureDurableGuestState } from "@/modules/profile/persistence";

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-persistence-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
});

describe("ensureDurableGuestState", () => {
  it("mints the lazy profile and requests persistent storage once granted", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const profile = await ensureDurableGuestState(
      db,
      { persist },
      { now: () => 1000, randomUUID: () => "uuid-a" },
    );
    expect(persist).toHaveBeenCalledTimes(1);
    expect(profile.deviceId).toBe("uuid-a");
    expect(profile.persistenceRequestedAt).toBe(1000);
    expect(profile.persistenceGranted).toBe(true);
    expect(await peekDeviceProfile(db)).toEqual(profile);
  });

  it("never requests again once persistence is granted", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    await ensureDurableGuestState(db, { persist });
    await ensureDurableGuestState(db, { persist });
    await ensureDurableGuestState(db, { persist });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("records a denial and retries on the next durable write", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const denied = await ensureDurableGuestState(
      db,
      { persist },
      { now: () => 111 },
    );
    expect(denied.persistenceRequestedAt).toBe(111);
    expect(denied.persistenceGranted).toBe(false);

    const granted = await ensureDurableGuestState(
      db,
      { persist },
      { now: () => 222 },
    );
    expect(persist).toHaveBeenCalledTimes(2);
    // The FIRST request time is preserved; the verdict is updated.
    expect(granted.persistenceRequestedAt).toBe(111);
    expect(granted.persistenceGranted).toBe(true);
  });

  it("a throwing persistence API records a non-verdict, not a crash", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("nope"));
    const profile = await ensureDurableGuestState(
      db,
      { persist },
      { now: () => 500 },
    );
    expect(profile.persistenceRequestedAt).toBe(500);
    expect(profile.persistenceGranted).toBeNull();
  });

  it("a later non-verdict never overwrites a real recorded denial", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("flaky"));
    await ensureDurableGuestState(db, { persist }, { now: () => 10 });
    const after = await ensureDurableGuestState(
      db,
      { persist },
      { now: () => 20 },
    );
    expect(persist).toHaveBeenCalledTimes(2);
    expect(after.persistenceRequestedAt).toBe(10);
    expect(after.persistenceGranted).toBe(false);
  });

  it("still mints the profile when the storage API is unavailable", async () => {
    const profile = await ensureDurableGuestState(db, undefined);
    expect(profile.deviceId).toBeTruthy();
    expect(profile.persistenceRequestedAt).toBeNull();
    expect(profile.persistenceGranted).toBeNull();
  });

  it("coalesces concurrent calls into a single persist request", async () => {
    // Two guest writes fired by one user action ("Reset appearance" writes
    // the theme and the font scale together) must never double the
    // permission prompt.
    let release: (granted: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const persist = vi.fn().mockReturnValue(gate);
    const first = ensureDurableGuestState(db, { persist });
    const second = ensureDurableGuestState(db, { persist });
    release(true);
    const [a, b] = await Promise.all([first, second]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.persistenceGranted).toBe(true);
  });

  it("a coalesced denial still allows the next distinct action to retry", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    // One action: two concurrent writes, one request, denied.
    const [a, b] = await Promise.all([
      ensureDurableGuestState(db, { persist }),
      ensureDurableGuestState(db, { persist }),
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(a.persistenceGranted).toBe(false);
    expect(b.persistenceGranted).toBe(false);
    // A later, distinct action retries because the in-flight entry cleared.
    const retried = await ensureDurableGuestState(db, { persist });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(retried.persistenceGranted).toBe(true);
  });
});
