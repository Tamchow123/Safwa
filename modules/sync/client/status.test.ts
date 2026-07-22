import { describe, expect, it } from "vitest";

import { deriveSyncStatus, type SyncStatusInput } from "./status";

const BASE: SyncStatusInput = {
  enabled: true,
  authenticated: true,
  online: true,
  running: false,
  pendingCount: 0,
  needsAttention: false,
};

describe("deriveSyncStatus", () => {
  it("guest wins over everything when not authenticated", () => {
    expect(
      deriveSyncStatus({
        ...BASE,
        authenticated: false,
        running: true,
        pendingCount: 5,
      }),
    ).toEqual({ kind: "guest", pendingCount: 0 });
  });

  it("disabled when sync is off (but authenticated)", () => {
    expect(
      deriveSyncStatus({ ...BASE, enabled: false, pendingCount: 3 }),
    ).toEqual({
      kind: "disabled",
      pendingCount: 0,
    });
  });

  it("syncing outranks attention/offline/pending", () => {
    expect(
      deriveSyncStatus({
        ...BASE,
        running: true,
        needsAttention: true,
        online: false,
        pendingCount: 4,
      }),
    ).toEqual({ kind: "syncing", pendingCount: 4 });
  });

  it("attention outranks offline and pending", () => {
    expect(
      deriveSyncStatus({
        ...BASE,
        needsAttention: true,
        online: false,
        pendingCount: 2,
      }),
    ).toEqual({ kind: "attention", pendingCount: 2 });
  });

  it("offline outranks pending", () => {
    expect(
      deriveSyncStatus({ ...BASE, online: false, pendingCount: 2 }),
    ).toEqual({
      kind: "offline",
      pendingCount: 2,
    });
  });

  it("pending when online with unsynced changes", () => {
    expect(deriveSyncStatus({ ...BASE, pendingCount: 7 })).toEqual({
      kind: "pending",
      pendingCount: 7,
    });
  });

  it("synced when online, nothing pending, no attention", () => {
    expect(deriveSyncStatus(BASE)).toEqual({ kind: "synced", pendingCount: 0 });
  });

  it("clamps a negative/NaN pendingCount to 0", () => {
    expect(deriveSyncStatus({ ...BASE, pendingCount: -3 })).toEqual({
      kind: "synced",
      pendingCount: 0,
    });
    expect(deriveSyncStatus({ ...BASE, pendingCount: Number.NaN })).toEqual({
      kind: "synced",
      pendingCount: 0,
    });
  });

  it("floors a fractional pendingCount", () => {
    expect(deriveSyncStatus({ ...BASE, pendingCount: 2.9 }).pendingCount).toBe(
      2,
    );
  });
});
