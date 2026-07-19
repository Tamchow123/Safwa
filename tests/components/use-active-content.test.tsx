/**
 * `useActiveContent`'s shared in-flight coalescing (Phase 13 §15 regression
 * coverage — added when the Progress page became the first page to mount
 * two independent snapshot hooks over the same release): two hook instances
 * mounted together share exactly ONE underlying `loadActiveContent()` call,
 * and a hung/slow load can never poison a later, wholly independent mount.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useActiveContent } from "@/components/content/use-active-content";
import type { LoadContentResult } from "@/modules/content/load";

const loadActiveContent = vi.fn<() => Promise<LoadContentResult>>();
vi.mock("@/modules/content/load", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/load")>();
  return { ...original, loadActiveContent: () => loadActiveContent() };
});

const readyResult: LoadContentResult = {
  ok: true,
  source: "cache",
  releaseId: "release-1",
  contentVersion: "1",
  questionGeneratorVersion: "1",
  entryCount: 0,
  entries: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("useActiveContent — shared in-flight coalescing", () => {
  it("coalesces two hooks mounted together into ONE underlying load", async () => {
    loadActiveContent.mockResolvedValue(readyResult);

    const { result: a } = renderHook(() => useActiveContent());
    const { result: b } = renderHook(() => useActiveContent());

    await waitFor(() => expect(a.current.state.status).toBe("ready"));
    await waitFor(() => expect(b.current.state.status).toBe("ready"));
    expect(loadActiveContent).toHaveBeenCalledTimes(1);
  });

  it("never lets a hung load poison a later, independent mount", async () => {
    // First mount: a load that never settles.
    loadActiveContent.mockImplementationOnce(() => new Promise(() => {}));
    const { result: hung } = renderHook(() => useActiveContent());
    expect(hung.current.state.status).toBe("loading");

    // Let the coalescing microtask flush before the second, later mount.
    await Promise.resolve();

    // A genuinely later, independent mount must NOT share the stuck promise.
    loadActiveContent.mockResolvedValueOnce(readyResult);
    const { result: fresh } = renderHook(() => useActiveContent());
    await waitFor(() => expect(fresh.current.state.status).toBe("ready"));

    expect(loadActiveContent).toHaveBeenCalledTimes(2);
    // The first hook is still legitimately loading — its own load really is
    // still pending, not silently reassigned to the second's result.
    expect(hung.current.state.status).toBe("loading");
  });
});
