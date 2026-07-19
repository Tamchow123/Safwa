/**
 * The bounded-await helper (Phase 12 full-phase review REL-P101/REL-P102):
 * passthrough on settle, labelled rejection on timeout, no leaked timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeoutError, withTimeout } from "@/lib/with-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("passes a resolution through untouched", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });

  it("passes an inner rejection through untouched", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("inner")), 1000, "x"),
    ).rejects.toThrow("inner");
  });

  it("rejects with the caller's label once the budget elapses", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(
      new Promise<never>(() => {}),
      5000,
      "read timed out",
    );
    const outcome = expect(pending).rejects.toThrow("read timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await outcome;
  });

  it("clears the timer when the promise settles first", async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve("ok"), 60_000, "x");
    // No pending timer remains to fire later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a TimeoutError specifically, distinguishable from an inner failure", async () => {
    // Callers discriminate "this gate genuinely timed out" from "the
    // wrapped operation itself failed" by TYPE, not by re-matching the
    // label string against error.message (a coincidental label collision
    // with an inner rejection's message must never be misread as a
    // timeout).
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => {}), 5000, "boom");
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5001);
    await expect(outcome).resolves.toBeInstanceOf(TimeoutError);

    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000, "boom"),
    ).rejects.not.toBeInstanceOf(TimeoutError);
  });
});
