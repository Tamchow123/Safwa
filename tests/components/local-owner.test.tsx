/**
 * Local-owner resolution (schema v6, R2-F3 / ARCH-002; Phase 18 §2).
 *
 * `useSession()` reports `data: undefined/null` while its session fetch is
 * still in flight — indistinguishable from "signed out". Reading the owner
 * from it to stamp a WRITE would therefore mark a signed-in user's bookmark,
 * setting or study session as a GUEST's: invisible to that account's
 * owner-scoped reads and never enqueued for sync. That is a narrower re-run of
 * the very R2-F1 defect the owner threading exists to close, so writes resolve
 * the owner at ACTION time via `useResolveOwner`.
 *
 * Phase 18 closes the other half of the same hole. `data?.user?.id ?? null`
 * also collapses "the server said nobody is signed in" into "the server never
 * answered", so an OFFLINE COLD BOOT while signed in reported guest. Both hooks
 * now classify, and the third verdict resolves to the durable last-known owner.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LAST_KNOWN_OWNER_STORAGE_KEY } from "@/modules/auth/last-known-owner";

const useSessionMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock("@/modules/auth/client", () => ({
  authClient: { getSession: () => getSessionMock() },
  useSession: () => useSessionMock(),
}));

const { useLocalOwner, useResolveOwner } =
  await import("@/components/sync/use-local-owner");

const ACCOUNT = { data: { user: { id: "acct-1" } }, isPending: false };
const PENDING = { data: undefined, isPending: true };
const SIGNED_OUT = { data: null, isPending: false, error: null };

/**
 * The exact state Better Auth's store lands in on a cold boot with no network
 * while signed in: the fetch REJECTED, so `isPending` is already false and
 * `data` was never populated. This is the shape that used to report guest.
 */
const OFFLINE_COLD_BOOT = {
  data: null,
  isPending: false,
  error: { status: 0 },
};

/** Seed / read the durable memory the way the module itself stores it. */
function seedRememberedOwner(id: string): void {
  localStorage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, id);
}
function rememberedOwner(): string | null {
  return localStorage.getItem(LAST_KNOWN_OWNER_STORAGE_KEY);
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("useLocalOwner (READ paths)", () => {
  it("reports the account id once the session has resolved", () => {
    useSessionMock.mockReturnValue(ACCOUNT);
    const { result } = renderHook(() => useLocalOwner());
    expect(result.current).toBe("acct-1");
  });

  it("reports the guest owner while the session is still pending", () => {
    // Conservative and correct for a read: the view shows un-owned data for
    // one render and re-renders with the account's data on resolution.
    useSessionMock.mockReturnValue(PENDING);
    const { result } = renderHook(() => useLocalOwner());
    expect(result.current).toBeNull();
  });

  it("reports the guest owner for a genuinely signed-out visitor", () => {
    useSessionMock.mockReturnValue(SIGNED_OUT);
    const { result } = renderHook(() => useLocalOwner());
    expect(result.current).toBeNull();
  });
});

describe("useLocalOwner — the offline cold boot (Phase 18 §2)", () => {
  it("resolves the REMEMBERED account, not a guest, when the server never answered", async () => {
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);

    const { result } = renderHook(() => useLocalOwner());

    // `null` for one render (storage is read in an effect, never during
    // render, because ~20 routes are prerendered), then the real answer.
    await waitFor(() => expect(result.current).toBe("acct-1"));
  });

  it("remembers the account so a LATER offline boot has something to fall back to", async () => {
    useSessionMock.mockReturnValue(ACCOUNT);
    renderHook(() => useLocalOwner());
    await waitFor(() => expect(rememberedOwner()).toBe("acct-1"));
  });

  it("FORGETS on a classified guest, so the memory cannot outlive the account", async () => {
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(SIGNED_OUT);

    renderHook(() => useLocalOwner());

    await waitFor(() => expect(rememberedOwner()).toBeNull());
  });

  it("does NOT forget merely because the session could not be resolved", async () => {
    // The whole point: an unreachable server is not evidence of a guest.
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);

    renderHook(() => useLocalOwner());

    await waitFor(() => expect(rememberedOwner()).toBe("acct-1"));
  });

  it("falls back to the guest owner when there is no memory either", async () => {
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);
    const { result } = renderHook(() => useLocalOwner());
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("ignores a corrupt remembered value rather than minting a bad owner key", async () => {
    seedRememberedOwner("   ");
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);

    const { result } = renderHook(() => useLocalOwner());
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("treats a 401 as a real answer: guest, and the memory is dropped", async () => {
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue({
      data: null,
      isPending: false,
      error: { status: 401 },
    });

    const { result } = renderHook(() => useLocalOwner());

    await waitFor(() => expect(rememberedOwner()).toBeNull());
    expect(result.current).toBeNull();
  });
});

describe("useResolveOwner (WRITE paths, ARCH-002)", () => {
  it("resolves the ACCOUNT — not a guest — when the session is still pending", async () => {
    useSessionMock.mockReturnValue(PENDING);
    getSessionMock.mockResolvedValue({ data: { user: { id: "acct-1" } } });

    const { result } = renderHook(() => useResolveOwner());
    await expect(result.current()).resolves.toBe("acct-1");
    // The pending window is the ONLY case that costs a session fetch.
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("answers from the resolved session without a fetch once it has settled", async () => {
    useSessionMock.mockReturnValue(ACCOUNT);
    const { result } = renderHook(() => useResolveOwner());

    await waitFor(async () => {
      await expect(result.current()).resolves.toBe("acct-1");
    });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("resolves the guest owner for a genuinely signed-out visitor", async () => {
    useSessionMock.mockReturnValue(SIGNED_OUT);
    const { result } = renderHook(() => useResolveOwner());

    await waitFor(async () => {
      await expect(result.current()).resolves.toBeNull();
    });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("resolves null for a pending session that turns out to be signed out", async () => {
    useSessionMock.mockReturnValue(PENDING);
    getSessionMock.mockResolvedValue({ data: null, error: null });

    const { result } = renderHook(() => useResolveOwner());
    await expect(result.current()).resolves.toBeNull();
  });

  it("falls back to the last known owner when the session fetch fails", async () => {
    // Offline / transient failure must not silently downgrade a signed-in
    // user's write to a guest-owned row.
    useSessionMock.mockReturnValue({
      data: { user: { id: "acct-1" } },
      isPending: true,
    });
    getSessionMock.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useResolveOwner());
    await expect(result.current()).resolves.toBe("acct-1");
  });

  it("returns a STABLE callback across re-renders (safe in effect deps)", () => {
    useSessionMock.mockReturnValue(ACCOUNT);
    const { result, rerender } = renderHook(() => useResolveOwner());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("useResolveOwner — writes during an offline cold boot", () => {
  it("stamps the REMEMBERED account, never a guest", async () => {
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);

    const { result } = renderHook(() => useResolveOwner());
    await waitFor(async () => {
      await expect(result.current()).resolves.toBe("acct-1");
    });
  });

  it("does NOT re-ask a server that already failed", async () => {
    // An `unknown` caused by an error goes straight to the durable memory: a
    // failed round trip per write, while offline, is exactly the cost that
    // would be paid when writes matter most. Only a genuinely PENDING session
    // is worth one authoritative read.
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);

    const { result } = renderHook(() => useResolveOwner());
    await waitFor(async () => {
      await expect(result.current()).resolves.toBe("acct-1");
    });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("resolves the guest owner when offline with no memory", async () => {
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);
    const { result } = renderHook(() => useResolveOwner());
    await waitFor(async () => {
      await expect(result.current()).resolves.toBeNull();
    });
  });

  it("remembers an account discovered by the late session read", async () => {
    // The pending window resolved to an account: that is a first-hand answer
    // from the server, so it is worth remembering for the next cold boot.
    useSessionMock.mockReturnValue(PENDING);
    getSessionMock.mockResolvedValue({
      data: { user: { id: "acct-2" } },
      error: null,
    });

    const { result } = renderHook(() => useResolveOwner());
    await expect(result.current()).resolves.toBe("acct-2");
    expect(rememberedOwner()).toBe("acct-2");
  });

  it("forgets when the late session read says the visitor is a guest", async () => {
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(PENDING);
    getSessionMock.mockResolvedValue({ data: null, error: null });

    const { result } = renderHook(() => useResolveOwner());
    await expect(result.current()).resolves.toBeNull();
    expect(rememberedOwner()).toBeNull();
  });

  it("keeps the memory when the late session read fails to reach the server", async () => {
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(PENDING);
    getSessionMock.mockResolvedValue({ data: null, error: { status: 503 } });

    const { result } = renderHook(() => useResolveOwner());
    await expect(result.current()).resolves.toBe("acct-1");
    expect(rememberedOwner()).toBe("acct-1");
  });
});

describe("storage is only touched when the answer can be used", () => {
  it("does not read storage on re-renders while the identity is resolved", () => {
    // `useSession()` is read by components that re-render often — the timed
    // quiz countdown re-renders five times a second — and for a signed-in
    // learner the snapshot would be read and thrown away every time. A
    // resolved verdict hands React a constant instead of a storage read.
    useSessionMock.mockReturnValue(ACCOUNT);
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    const { rerender } = renderHook(() => useLocalOwner());
    getItem.mockClear();
    rerender();
    rerender();
    rerender();

    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it("does read storage while the identity is unresolved, where it is needed", () => {
    seedRememberedOwner("acct-1");
    useSessionMock.mockReturnValue(OFFLINE_COLD_BOOT);
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    const { result } = renderHook(() => useLocalOwner());

    expect(getItem).toHaveBeenCalled();
    expect(result.current).toBe("acct-1");
    getItem.mockRestore();
  });
});

describe("an account switch replaces the memory", () => {
  it("remembers the new account, not the old one", async () => {
    useSessionMock.mockReturnValue(ACCOUNT);
    const { rerender } = renderHook(() => useLocalOwner());
    await waitFor(() => expect(rememberedOwner()).toBe("acct-1"));

    useSessionMock.mockReturnValue({
      data: { user: { id: "acct-2" } },
      isPending: false,
    });
    rerender();

    await waitFor(() => expect(rememberedOwner()).toBe("acct-2"));
  });
});
