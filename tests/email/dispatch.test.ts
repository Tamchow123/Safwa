import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  dispatchEmail,
  flushPendingEmails,
  pendingCountForTests,
} from "@/modules/email/dispatch";

/**
 * Unit coverage for the background email-dispatch primitive itself
 * (Phase 15 review fix) — modules/auth/server.ts's callback-level tests
 * (tests/auth/server-config.test.ts) cover the Better Auth wiring; this
 * file covers dispatchEmail/flushPendingEmails in isolation.
 */
describe("modules/email/dispatch", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns before the wrapped send resolves", () => {
    let resolveSend: (() => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<{ success: true; messageId: string }>((resolve) => {
          resolveSend = () => resolve({ success: true, messageId: "id-1" });
        }),
    );

    dispatchEmail(send);

    expect(send).toHaveBeenCalledTimes(1);
    resolveSend?.();
  });

  it("flushPendingEmails waits for every dispatched send to settle", async () => {
    let resolveSend: (() => void) | undefined;
    dispatchEmail(
      () =>
        new Promise((resolve) => {
          resolveSend = () => resolve({ success: true, messageId: "id-2" });
        }),
    );

    let flushed = false;
    const flushPromise = flushPendingEmails().then(() => {
      flushed = true;
    });
    // Give any already-queued microtasks a chance to run — flushed must
    // still be false here since the underlying send has not resolved yet.
    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveSend?.();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it("a rejected send is caught and logged, never becoming an unhandled rejection", async () => {
    dispatchEmail(() => Promise.reject(new Error("boom")));
    await flushPendingEmails();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[email:dispatch] delivery failed",
      expect.any(Error),
    );
  });

  it("flushPendingEmails clears the queue (a second call has nothing left to wait for)", async () => {
    dispatchEmail(() => Promise.resolve({ success: true, messageId: "id-3" }));
    await flushPendingEmails();
    await expect(flushPendingEmails()).resolves.toBeUndefined();
  });

  it("self-prunes a settled entry without flushPendingEmails ever being called (bounds long-lived process memory)", async () => {
    dispatchEmail(() => Promise.resolve({ success: true, messageId: "id-4" }));
    // Several microtask ticks: send()'s own resolution, the internal
    // .then().catch() chain that builds `settled`, and the additional
    // .then() continuation that filters the settled entry out of
    // `pending` — neither this nor flushPendingEmails is called, which
    // would mask a missing prune by clearing the array itself regardless.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(pendingCountForTests()).toBe(0);
  });
});
