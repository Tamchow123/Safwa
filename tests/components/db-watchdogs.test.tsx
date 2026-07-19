/**
 * Bounded gate hooks (Phase 12 full-phase review REL-P101): a local
 * persistence read that never settles — e.g. an IndexedDB open blocked
 * behind another tab's connection during the v2→v3 upgrade — must never
 * strand a page behind an un-retriable gate. Content fails over to the
 * recoverable error+retry state; the settings reads fail over to their
 * safe documented defaults with `loaded` flipped true.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTENT_WATCHDOG_MS,
  useActiveContent,
} from "@/components/content/use-active-content";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import { useTimezonePreference } from "@/lib/preferences/use-timezone";
import { DB_READ_TIMEOUT_MS } from "@/lib/with-timeout";
import { DEFAULT_SESSION_DEFAULTS } from "@/modules/profile/session-defaults";

vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});

// Every gated read hangs forever by default — the blocked-upgrade shape.
// Individual tests override with mockRejectedValueOnce/mockResolvedValueOnce
// to exercise the OTHER branches of the same watchdog-vs-real-error catch.
const loadActiveContent = vi.fn(() => new Promise<never>(() => {}));
vi.mock("@/modules/content/load", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/load")>();
  return {
    ...original,
    loadActiveContent: (...args: Parameters<typeof loadActiveContent>) =>
      loadActiveContent(...args),
  };
});

vi.mock("@/modules/profile/session-defaults", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/session-defaults")>();
  return {
    ...original,
    readSessionDefaults: vi.fn(() => new Promise<never>(() => {})),
  };
});

vi.mock("@/modules/profile/timezone", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/timezone")>();
  return {
    ...original,
    readTimezonePreference: vi.fn(() => new Promise<never>(() => {})),
  };
});

afterEach(() => {
  vi.useRealTimers();
  loadActiveContent.mockClear();
});

describe("gate watchdogs for a hung local database", () => {
  it("useActiveContent fails over to the recoverable error state", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useActiveContent());
    expect(result.current.state.status).toBe("loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_WATCHDOG_MS + 1);
    });
    expect(result.current.state.status).toBe("error");
    expect(
      result.current.state.status === "error" && result.current.state.message,
    ).toContain("another tab");
  });

  it("useActiveContent surfaces the generic failure message for a REAL (non-watchdog) error", async () => {
    // The catch branch discriminates the watchdog's own sentinel from any
    // other thrown error (§TEST-002): a genuine load failure (corrupt cache,
    // quota exceeded, a bug in loadActiveContent) must never be mistaken for
    // a hung-connection watchdog timeout — that would show "close the other
    // tab and retry" advice that cannot fix the learner's actual problem.
    loadActiveContent.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useActiveContent());
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(
      result.current.state.status === "error" && result.current.state.message,
    ).toBe("Something went wrong loading content. Please retry.");
    expect(
      result.current.state.status === "error" && result.current.state.message,
    ).not.toContain("another tab");
  });

  it("useSessionDefaults fails over to the documented defaults, loaded", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSessionDefaults());
    expect(result.current.loaded).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DB_READ_TIMEOUT_MS + 1);
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.defaults).toEqual(DEFAULT_SESSION_DEFAULTS);
  });

  it("useTimezonePreference fails over to browser detection, loaded", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTimezonePreference());
    expect(result.current.loaded).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DB_READ_TIMEOUT_MS + 1);
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.preference).toEqual({ mode: "browser" });
  });
});
