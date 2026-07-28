import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SafwaDb } from "@/modules/content/db";
import { emptyGuestMergeSummary } from "@/modules/sync/protocol";

import { GuestSnapshotTooLargeError, type GuestSnapshot } from "./guest-snapshot"; // prettier-ignore
import { GuestMergeChunkOverflowError } from "./guest-merge-chunking";
import {
  guestMergeReducer,
  initialGuestMergeState,
  MAX_REBASE_ATTEMPTS,
  type GuestMergeEvent,
  type GuestMergeState,
} from "./guest-merge-machine";
import type {
  GuestMergeUploadOutcome,
  uploadGuestMerge,
} from "./guest-merge-upload";
import type { finaliseGuestMerge } from "./guest-merge-finalise";
import { isGuestMergeRunning, runGuestMerge } from "./guest-merge-runner";

const USER = "11111111-1111-4111-8111-111111111111";
const IMPORT_KEY = "0192f9a0-1111-7abc-8def-0123456789ab";
const NOW = Date.parse("2026-07-28T09:00:00.000Z");

/** The runner never inspects the snapshot's contents — only passes it on. */
function snapshot(): GuestSnapshot {
  return {
    version: 1,
    deviceId: "device-1",
    attempts: [],
    events: [],
    bookmarks: [],
    lists: [],
    settings: [],
    skipped: { events: 2, attempts: 0, bookmarks: 0, lists: 0, settings: 0 },
  };
}

function applied(
  overrides: Partial<Extract<GuestMergeUploadOutcome, { status: "completed" }>> = {}, // prettier-ignore
): GuestMergeUploadOutcome {
  return {
    status: "completed",
    result: "applied",
    summary: { ...emptyGuestMergeSummary(), eventsApplied: 7 },
    listIdMappings: [],
    serverCursor: 41,
    importKey: IMPORT_KEY,
    ...overrides,
  };
}

type Harness = {
  events: GuestMergeEvent[];
  state: () => GuestMergeState;
  rebase: ReturnType<typeof vi.fn>;
  finalise: ReturnType<typeof vi.fn>;
  run: (options?: {
    upload?: GuestMergeUploadOutcome;
    collectError?: unknown;
    rebaseResults?: boolean[];
    isCurrentAccount?: (userId: string) => boolean;
  }) => Promise<void>;
};

/**
 * Drives the runner against the REAL reducer, so a test asserts the state a
 * learner would actually be shown rather than the runner's own event log alone.
 */
function harness(): Harness {
  const events: GuestMergeEvent[] = [];
  // The real sequence up to the point the runner is legally allowed to start:
  // the session resolves, the data check finds something, and the learner
  // consents. Without the consent the machine is still in `checking` and would
  // ignore every event the runner emits — which is the rule, not a quirk.
  let state = [
    { type: "session-resolved", userId: USER },
    {
      type: "guest-data-checked",
      counts: { components: 1, events: 2, attempts: 2, bookmarks: 0, lists: 0 },
      meaningful: true,
    },
    { type: "consented" },
  ].reduce<GuestMergeState>(
    (acc, event) => guestMergeReducer(acc, event as GuestMergeEvent),
    initialGuestMergeState(),
  );
  const rebase = vi.fn();
  const finalise = vi.fn(async () => Promise.resolve(undefined));

  return {
    events,
    state: () => state,
    rebase,
    finalise,
    run: async (options = {}) => {
      const results = options.rebaseResults ?? [true];
      let call = 0;
      rebase.mockImplementation(async () =>
        Promise.resolve(results[Math.min(call++, results.length - 1)] ?? false),
      );
      await runGuestMerge({
        db: {} as SafwaDb,
        userId: USER,
        now: () => NOW,
        isCurrentAccount: options.isCurrentAccount ?? (() => true),
        rebase: rebase as unknown as () => Promise<boolean>,
        dispatch: (event) => {
          events.push(event);
          state = guestMergeReducer(state, event);
        },
        collect: async () => {
          if (options.collectError) throw options.collectError;
          return Promise.resolve(snapshot());
        },
        upload: (async () =>
          Promise.resolve(
            options.upload ?? applied(),
          )) as unknown as typeof uploadGuestMerge,
        finalise: finalise as unknown as typeof finaliseGuestMerge,
      });
    },
  };
}

beforeEach(() => {
  // The consent step the machine requires before any of this is legal.
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("the happy path", () => {
  it("collects, uploads, finalises and rebases, and only then completes", async () => {
    const h = harness();
    await h.run();
    expect(h.events.map((e) => e.type)).toEqual([
      "snapshot-collected",
      "upload-finalising",
      "upload-succeeded",
      "rebase-succeeded",
    ]);
    expect(h.state().flow.name).toBe("completed");
  });

  it("finalises locally before it claims anything", async () => {
    // §20: the device must agree before the learner is told the merge is done.
    const h = harness();
    await h.run();
    expect(h.finalise).toHaveBeenCalledTimes(1);
    expect(h.finalise.mock.calls[0]?.[1]).toMatchObject({
      userId: USER,
      importKey: IMPORT_KEY,
      now: NOW,
    });
  });

  it("counts locally-skipped records in the summary the learner is shown", async () => {
    // The snapshot dropped two events as unsendable. A summary reporting only
    // what the server saw would under-count what did not arrive.
    const h = harness();
    await h.run();
    const succeeded = h.events.find((e) => e.type === "upload-succeeded");
    expect(succeeded).toMatchObject({ summary: { needingAttention: 2 } });
  });

  it("reports a no-op as a no-op, on the server's word", async () => {
    const h = harness();
    await h.run({ upload: applied({ result: "no_op" }) });
    expect(h.state().flow.name).toBe("completed-no-op");
  });
});

describe("the rebase is not optional (REL-002-T13b)", () => {
  it("retries a pull that does not land, then stops claiming success", async () => {
    const h = harness();
    await h.run({ rebaseResults: [false] });
    expect(h.rebase).toHaveBeenCalledTimes(MAX_REBASE_ATTEMPTS);
    expect(h.state().flow).toMatchObject({
      name: "retryable-error",
      reason: { kind: "rebase-failed" },
    });
    expect(h.state().flow.name).not.toBe("completed");
  });

  it("stops as soon as a pull lands", async () => {
    const h = harness();
    await h.run({ rebaseResults: [false, true] });
    expect(h.rebase).toHaveBeenCalledTimes(2);
    expect(h.state().flow.name).toBe("completed");
  });

  it("treats a throwing pull as a failed one rather than propagating", async () => {
    const h = harness();
    h.rebase.mockRejectedValue(new Error("offline"));
    await expect(
      runGuestMerge({
        db: {} as SafwaDb,
        userId: USER,
        now: () => NOW,
        isCurrentAccount: () => true,
        rebase: h.rebase as unknown as () => Promise<boolean>,
        dispatch: () => {},
        collect: async () => Promise.resolve(snapshot()),
        upload: (async () =>
          Promise.resolve(applied())) as unknown as typeof uploadGuestMerge,
        finalise: h.finalise as unknown as typeof finaliseGuestMerge,
      }),
    ).resolves.toBeUndefined();
    expect(h.rebase).toHaveBeenCalledTimes(MAX_REBASE_ATTEMPTS);
  });
});

describe("stopping honestly", () => {
  it("reports an oversized history as attention, having sent nothing", async () => {
    const h = harness();
    await h.run({
      collectError: new GuestSnapshotTooLargeError("events", 30_000, 20_000),
    });
    expect(h.state().flow).toEqual({
      name: "attention-required",
      reason: { kind: "snapshot-too-large" },
    });
  });

  it("reports a history that cannot be chunked the same way", async () => {
    const h = harness();
    await h.run({ collectError: new GuestMergeChunkOverflowError(102, 100) });
    expect(h.state().flow).toMatchObject({
      name: "attention-required",
      reason: { kind: "snapshot-too-large" },
    });
  });

  it("passes a server refusal through with its reason code", async () => {
    const h = harness();
    await h.run({
      upload: {
        status: "rejected",
        reasonCode: "snapshot_mismatch",
        importKey: IMPORT_KEY,
      },
    });
    expect(h.state().flow).toEqual({
      name: "attention-required",
      reason: { kind: "server", reasonCode: "snapshot_mismatch" },
    });
  });

  it("offers a retry for a retryable interruption", async () => {
    const h = harness();
    await h.run({
      upload: {
        status: "interrupted",
        retryable: true,
        failure: "network",
        importKey: IMPORT_KEY,
      },
    });
    expect(h.state().flow).toMatchObject({
      name: "retryable-error",
      reason: { kind: "transport", failure: "network" },
    });
  });

  it("does NOT offer a retry for a lost session", async () => {
    // Retrying cannot repair it; signing in again can.
    const h = harness();
    await h.run({
      upload: {
        status: "interrupted",
        retryable: false,
        failure: "unauthorized",
        importKey: IMPORT_KEY,
      },
    });
    expect(h.state().flow.name).toBe("attention-required");
  });

  it("treats a failed LOCAL finalisation as retryable, not as a failed merge", async () => {
    // The server side is durable. Retrying under the same key answers
    // `already_completed` and resends nothing.
    const h = harness();
    h.finalise.mockRejectedValue(new Error("quota exceeded"));
    await h.run();
    expect(h.state().flow).toMatchObject({
      name: "retryable-error",
      reason: { kind: "local" },
    });
    expect(h.state().flow.name).not.toBe("completed");
  });
});

describe("single-flight per account (REL-002-T13a)", () => {
  /** A run that blocks in `collect` until released. */
  function gated() {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collect = vi.fn(async () => {
      await gate;
      return snapshot();
    });
    const make = (dispatch: (event: GuestMergeEvent) => void) => ({
      db: {} as SafwaDb,
      userId: USER,
      now: () => NOW,
      isCurrentAccount: () => true,
      rebase: async () => Promise.resolve(true),
      dispatch,
      collect,
      upload: (async () =>
        Promise.resolve(applied())) as unknown as typeof uploadGuestMerge,
      finalise: (async () =>
        Promise.resolve(undefined)) as unknown as typeof finaliseGuestMerge,
    });
    return { release: () => release(), collect, make };
  }

  it("runs the merge ONCE for two overlapping starts", async () => {
    // The assertion that matters is `collect` being called once — not merely
    // that the flag was released, which would still hold if the guard were
    // removed and both runs completed one after the other. The upload driver
    // holds no lock of its own, so this is where the promise is actually kept.
    const { release, collect, make } = gated();
    const second: GuestMergeEvent[] = [];

    const first = runGuestMerge(make(() => {}));
    expect(isGuestMergeRunning(USER)).toBe(true);
    const joined = runGuestMerge(make((event) => second.push(event)));

    release();
    await Promise.all([first, joined]);

    expect(collect).toHaveBeenCalledTimes(1);
    // The second caller's own dispatch is never used: it joined a run that
    // already had one. This is why the provider ALSO refuses to move its state
    // when `isGuestMergeRunning` is true — otherwise its screen would sit in
    // `preparing` waiting for events routed to the first caller.
    expect(second).toEqual([]);
    expect(isGuestMergeRunning(USER)).toBe(false);
  });

  it("hands the second caller the SAME run to await, not a silent no-op", async () => {
    // Coalescing rather than refusing: a caller that awaits gets the real
    // outcome instead of a promise that resolves before the work is done.
    const { release, make } = gated();
    const first = runGuestMerge(make(() => {}));
    const joined = runGuestMerge(make(() => {}));
    expect(joined).toBe(first);
    release();
    await first;
  });

  it("releases the slot even when the run stops early", async () => {
    const h = harness();
    await h.run({ collectError: new Error("boom") });
    expect(isGuestMergeRunning(USER)).toBe(false);
  });
});

describe("the account-switch guard", () => {
  it("writes nothing once the account is no longer current", async () => {
    const h = harness();
    await h.run({ isCurrentAccount: () => false });
    expect(h.events).toEqual([]);
    expect(h.state().flow.name).toBe("preparing");
  });
});
