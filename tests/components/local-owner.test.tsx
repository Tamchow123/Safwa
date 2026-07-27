/**
 * Local-owner resolution (schema v6, R2-F3 / ARCH-002).
 *
 * `useSession()` reports `data: undefined/null` while its session fetch is
 * still in flight — indistinguishable from "signed out". Reading the owner
 * from it to stamp a WRITE would therefore mark a signed-in user's bookmark,
 * setting or study session as a GUEST's: invisible to that account's
 * owner-scoped reads and never enqueued for sync. That is a narrower re-run of
 * the very R2-F1 defect the owner threading exists to close, so writes resolve
 * the owner at ACTION time via `useResolveOwner`.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const SIGNED_OUT = { data: null, isPending: false };

afterEach(() => {
  vi.clearAllMocks();
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
    getSessionMock.mockResolvedValue({ data: null });

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
