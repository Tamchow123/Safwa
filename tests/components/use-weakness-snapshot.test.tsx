/**
 * useWeaknessSnapshot (Phase 13 §7, §15): loading/ready/error states, the
 * bounded watchdog for a hung read, visibility-triggered refresh, and retry
 * — mirrors useAnalyticsSnapshot's tested contract.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWeaknessSnapshot } from "@/components/analytics/use-weakness-snapshot";
import type { ActiveContentState } from "@/components/content/use-active-content";

const readyState: ActiveContentState = {
  status: "ready",
  entries: [],
  releaseId: "release-weakness-test",
  contentVersion: "0",
  questionGeneratorVersion: "1",
  entryCount: 0,
  source: "cache",
};

let contentState: ActiveContentState = readyState;
const retryContent = vi.fn();

vi.mock("@/components/content/use-active-content", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/content/use-active-content")
    >();
  return {
    ...original,
    useActiveContent: () => ({ state: contentState, retry: retryContent }),
  };
});

vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});

vi.mock("@/modules/profile/timezone", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/timezone")>();
  return {
    ...original,
    readEffectiveClock: vi.fn(async () => ({
      now: () => 1_784_000_000_000,
      timezone: "UTC",
      timezoneSource: "browser_detected" as const,
    })),
  };
});

const emptyView = {
  componentWeakness: new Map(),
  weaknessEvidence: new Map(),
  groups: {
    bab: [],
    verb_type: [],
    source_form: [],
    direction: [],
    skill: [],
    state: [],
  },
  topOverall: [],
};

const loadWeaknessView = vi.fn(async () => emptyView);
vi.mock("@/modules/analytics/weakness-persistence", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/modules/analytics/weakness-persistence")
    >();
  return {
    ...original,
    loadWeaknessView: (...args: Parameters<typeof loadWeaknessView>) =>
      loadWeaknessView(...args),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  contentState = readyState;
});

describe("useWeaknessSnapshot", () => {
  it("loads and reaches the ready state with the resolved view", async () => {
    const { result } = renderHook(() => useWeaknessSnapshot());
    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(
      result.current.state.status === "ready" && result.current.state.view,
    ).toEqual(emptyView);
  });

  it("surfaces the recoverable error state on a real load failure", async () => {
    loadWeaknessView.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useWeaknessSnapshot());
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(
      result.current.state.status === "error" && result.current.state.message,
    ).toContain("Your study history is safe");
  });

  it("fails over to the timeout message when the load never settles (watchdog)", async () => {
    vi.useFakeTimers();
    loadWeaknessView.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useWeaknessSnapshot());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    expect(result.current.state.status).toBe("error");
    expect(
      result.current.state.status === "error" && result.current.state.message,
    ).toContain("another tab");
  });

  it("propagates the content hook's loading/error states before attempting a weakness load", async () => {
    contentState = { status: "loading" };
    const { result, rerender } = renderHook(() => useWeaknessSnapshot());
    expect(result.current.state.status).toBe("loading");
    expect(loadWeaknessView).not.toHaveBeenCalled();

    contentState = { status: "error", message: "content failed" };
    rerender();
    expect(result.current.state).toEqual({
      status: "error",
      message: "content failed",
    });
  });

  it("retry re-invokes the load", async () => {
    const { result } = renderHook(() => useWeaknessSnapshot());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(loadWeaknessView).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(loadWeaknessView).toHaveBeenCalledTimes(2));
  });
});
