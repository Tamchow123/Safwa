/**
 * useCollections (Phase 14 §10): loading/ready/error states, the bounded
 * watchdog for a hung read, visibility-triggered refresh, and a silent
 * background refresh that never re-shows a loading skeleton once a
 * snapshot already exists.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCollections } from "@/components/collections/use-collections";
import type { CollectionsRaw } from "@/modules/collections/persistence";

vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});

const readCollections = vi.fn(async (): Promise<CollectionsRaw> => ({
  bookmarks: [],
  lists: [],
}));
vi.mock("@/modules/collections/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/collections/persistence")>();
  return {
    ...original,
    readCollections: (...args: Parameters<typeof readCollections>) =>
      readCollections(...args),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useCollections", () => {
  it("loads and reaches the ready state with a derived snapshot", async () => {
    readCollections.mockResolvedValueOnce({
      bookmarks: [{ entryId: 7, createdAt: 1 }],
      lists: [
        {
          id: "list-1",
          name: "Verbs",
          entryIds: [7],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const { result } = renderHook(() => useCollections());
    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("expected ready");
    expect(state.snapshot.bookmarkedEntryIds.has(7)).toBe(true);
    expect(state.snapshot.listsById.get("list-1")?.name).toBe("Verbs");
  });

  it("surfaces the recoverable error state on a real load failure", async () => {
    readCollections.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    const state = result.current.state;
    if (state.status !== "error") throw new Error("expected error");
    expect(state.message).toContain("Couldn't load your saved vocabulary");
  });

  it("fails over to the timeout message when the load never settles (watchdog)", async () => {
    vi.useFakeTimers();
    readCollections.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useCollections());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    const state = result.current.state;
    if (state.status !== "error") throw new Error("expected error");
    expect(state.message).toContain("another tab");
  });

  it("refresh re-invokes the load", async () => {
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(readCollections).toHaveBeenCalledTimes(1);
    act(() => result.current.refresh());
    await waitFor(() => expect(readCollections).toHaveBeenCalledTimes(2));
  });

  it("a background refresh keeps the existing snapshot visible (no loading flash)", async () => {
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    let sawLoading = false;
    readCollections.mockImplementationOnce(async () => {
      if (result.current.state.status === "loading") sawLoading = true;
      return { bookmarks: [], lists: [] };
    });
    act(() => result.current.refresh());
    await waitFor(() => expect(readCollections).toHaveBeenCalledTimes(2));
    expect(sawLoading).toBe(false);
    expect(result.current.state.status).toBe("ready");
  });

  it("a background refresh failure keeps the last known-good snapshot", async () => {
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    readCollections.mockRejectedValueOnce(new Error("transient"));
    act(() => result.current.refresh());
    await waitFor(() => expect(readCollections).toHaveBeenCalledTimes(2));
    expect(result.current.state.status).toBe("ready");
  });

  it("a PERSISTENT run of background failures eventually surfaces the recoverable error state", async () => {
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    // Three consecutive failures, each scoped with "Once" so no persistent
    // rejection leaks into a later, unrelated test via vi.clearAllMocks()
    // (which clears call history but not a non-Once implementation).
    readCollections.mockRejectedValueOnce(new Error("persistent-1"));
    readCollections.mockRejectedValueOnce(new Error("persistent-2"));
    readCollections.mockRejectedValueOnce(new Error("persistent-3"));
    // Never disturbs the UI for the first couple of failures.
    act(() => result.current.refresh());
    await waitFor(() => expect(readCollections).toHaveBeenCalledTimes(2));
    expect(result.current.state.status).toBe("ready");
    act(() => result.current.refresh());
    await waitFor(() => expect(readCollections).toHaveBeenCalledTimes(3));
    expect(result.current.state.status).toBe("ready");
    // The third consecutive failure crosses the bound: never stale forever.
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state.status).toBe("error"));
  });

  it("becoming visible again triggers a refresh", async () => {
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(readCollections).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(readCollections).toHaveBeenCalledTimes(2));
  });
});
