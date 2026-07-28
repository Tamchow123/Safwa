import { describe, expect, it } from "vitest";

import type { GuestDataSummary } from "./guest-snapshot";
import type { GuestMergeSummaryView } from "./guest-merge-summary";
import {
  canStartGuestMerge,
  guestMergeReducer,
  initialGuestMergeState,
  isGuestMergeActive,
  MAX_REBASE_ATTEMPTS,
  type GuestMergeEvent,
  type GuestMergeFlow,
  type GuestMergeSession,
  type GuestMergeState,
} from "./guest-merge-machine";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

const COUNTS: GuestDataSummary = {
  components: 4,
  events: 12,
  attempts: 12,
  bookmarks: 3,
  lists: 1,
};

const SUMMARY: GuestMergeSummaryView = {
  kind: "applied",
  attemptsImported: 12,
  eventsImported: 12,
  componentsUpdated: 4,
  bookmarksAdded: 3,
  listsCreated: 1,
  listsCombined: 0,
  settingsFilled: 2,
  alreadyPresent: 0,
  needingAttention: 0,
};

/** Run a sequence of events from the initial state. */
function run(...events: GuestMergeEvent[]): GuestMergeState {
  return events.reduce(guestMergeReducer, initialGuestMergeState());
}

/** A state with `account` already resolved, for testing one flow step. */
function at(
  flow: GuestMergeFlow,
  session: GuestMergeSession = { status: "signed-in", userId: ACCOUNT_A },
): GuestMergeState {
  return { session, flow };
}

const signedIn: GuestMergeEvent = {
  type: "session-resolved",
  userId: ACCOUNT_A,
};
const signedOut: GuestMergeEvent = { type: "session-resolved", userId: null };
const hasData: GuestMergeEvent = {
  type: "guest-data-checked",
  counts: COUNTS,
  meaningful: true,
};
const succeeded: GuestMergeEvent = {
  type: "upload-succeeded",
  summary: SUMMARY,
  changedAnything: true,
};

/** Everything up to and including the server saying the merge applied. */
function throughUpload(): GuestMergeEvent[] {
  return [
    signedIn,
    hasData,
    { type: "consented" },
    { type: "snapshot-collected" },
    { type: "upload-finalising" },
    succeeded,
  ];
}

describe("the machine knows WHOSE merge this is", () => {
  it("starts with nobody resolved and refuses to act on data", () => {
    expect(initialGuestMergeState()).toEqual({
      session: { status: "unresolved" },
      flow: { name: "checking" },
    });
    // A data check that beats the session to the finish line decides NOTHING.
    // Acting on it would offer to move data belonging to a learner nobody has
    // identified yet — the pending-session misclassification §19 forbids.
    expect(run(hasData)).toEqual({
      session: { status: "unresolved" },
      flow: { name: "checking" },
    });
    // Once the session lands, the SAME check is honoured.
    expect(run(hasData, signedIn, hasData).flow.name).toBe("ready-for-consent");
  });

  it("does not leave checking on a signed-in session alone", () => {
    // The offer appears only once the session is resolved AND the data is
    // known. Moving here would show a prompt naming counts nobody has counted.
    expect(run(signedIn)).toEqual({
      session: { status: "signed-in", userId: ACCOUNT_A },
      flow: { name: "checking" },
    });
  });

  it("shows nothing to a signed-out learner — there is no account to merge into", () => {
    expect(run(signedOut)).toEqual({
      session: { status: "signed-out" },
      flow: { name: "no-guest-data" },
    });
  });

  it("keeps refusing after sign-out, however often the data check re-fires", () => {
    // REL-002-T14a. A signed-out learner goes on studying, so a periodic guest
    // data check keeps firing with meaningful data. Without the account gate it
    // walked straight from `no-guest-data` to a consent prompt shown to
    // somebody with no account to merge into.
    const state = run(signedIn, hasData, signedOut, hasData, hasData);
    expect(state).toEqual({
      session: { status: "signed-out" },
      flow: { name: "no-guest-data" },
    });
    expect(canStartGuestMerge(state)).toBe(false);
  });

  it("starts over when a DIFFERENT account signs in", () => {
    // COMMIT-001 / REL-001-T14a. Account A's counts, consent offer and summary
    // are A's. Carrying any of them into B's session would offer B somebody
    // else's history.
    const state = run(signedIn, hasData, {
      type: "session-resolved",
      userId: ACCOUNT_B,
    });
    expect(state).toEqual({
      session: { status: "signed-in", userId: ACCOUNT_B },
      flow: { name: "checking" },
    });
  });

  it("ignores the same account re-asserting itself", () => {
    // Auth hooks re-report on every render and on every window focus. Treating
    // each one as news would wipe a completed summary off the screen the moment
    // the learner looked away and back.
    const done = run(...throughUpload(), { type: "rebase-succeeded" });
    expect(done.flow.name).toBe("completed");
    expect(guestMergeReducer(done, signedIn)).toEqual(done);
    expect(guestMergeReducer(guestMergeReducer(done, signedIn), signedIn)).toEqual(done); // prettier-ignore
  });

  it("does not quietly forget a merge that was in flight when the session went", () => {
    // REL-001-T14a. By `rebasing` the server side may already be durable and
    // finalisation has already dropped this device's component projections, so
    // reporting "nothing to see" would hide a half-applied merge behind a blank
    // screen. It needs signing in again — an action outside this flow.
    const state = guestMergeReducer(run(...throughUpload()), signedOut);
    expect(state).toEqual({
      session: { status: "signed-out" },
      flow: {
        name: "attention-required",
        reason: { kind: "session-changed" },
      },
    });
    expect(isGuestMergeActive(state)).toBe(false);
    expect(canStartGuestMerge(state)).toBe(false);
  });

  it("does not forget an in-flight merge when a DIFFERENT account signs in", () => {
    // REL-001-T14a-2. The sibling of the sign-out case, and the one an earlier
    // fix missed by guarding only the sign-out branch: a session hook can report
    // a new identity without ever passing through signed-out (a multi-account
    // switcher, a token refresh that swaps identity). Resetting to `checking`
    // there discards the rebase attempt and the server's summary just as
    // silently.
    const state = guestMergeReducer(run(...throughUpload()), {
      type: "session-resolved",
      userId: ACCOUNT_B,
    });
    expect(state).toEqual({
      session: { status: "signed-in", userId: ACCOUNT_B },
      flow: { name: "attention-required", reason: { kind: "session-changed" } },
    });
  });

  it("keeps the pending-pull signal when a rebase-exhausted merge loses its session", () => {
    // REL-001-T14a-3. This `retryable-error` is not idle: the server applied the
    // merge and finalisation already dropped this device's projections, so a
    // pull is still owed. Resetting to `no-guest-data` would forget that.
    let state = run(...throughUpload());
    for (let i = 0; i < MAX_REBASE_ATTEMPTS; i += 1) {
      state = guestMergeReducer(state, { type: "rebase-failed" });
    }
    expect(state.flow).toMatchObject({ name: "retryable-error" });
    expect(guestMergeReducer(state, signedOut).flow).toEqual({
      name: "attention-required",
      reason: { kind: "session-changed" },
    });
  });

  it("does NOT raise attention for an idle flow whose identity merely changed", () => {
    // The guard is about outstanding work, not about change itself. A learner
    // who was only being offered a merge, or who had finished one, has nothing
    // owed — the next identity starts cleanly rather than inheriting a warning.
    const offered = run(signedIn, hasData);
    expect(
      guestMergeReducer(offered, {
        type: "session-resolved",
        userId: ACCOUNT_B,
      }).flow,
    ).toEqual({ name: "checking" });
    const done = run(...throughUpload(), { type: "rebase-succeeded" });
    expect(
      guestMergeReducer(done, { type: "session-resolved", userId: ACCOUNT_B })
        .flow,
    ).toEqual({ name: "checking" });
  });

  it("lets the newly signed-in account start its own merge afterwards", () => {
    // Otherwise the arriving learner inherits a terminal state about somebody
    // else's merge and can never merge their own data.
    const inherited = guestMergeReducer(run(...throughUpload()), {
      type: "session-resolved",
      userId: ACCOUNT_B,
    });
    expect(inherited.flow.name).toBe("attention-required");
    const rechecked = guestMergeReducer(inherited, hasData);
    expect(rechecked.flow).toEqual({
      name: "ready-for-consent",
      counts: COUNTS,
    });
    expect(canStartGuestMerge(rechecked)).toBe(true);
  });

  it("reports no-guest-data when the check finds nothing meaningful", () => {
    expect(
      run(signedIn, { type: "guest-data-checked", counts: COUNTS, meaningful: false }).flow.name, // prettier-ignore
    ).toBe("no-guest-data");
  });
});

describe("nothing is sent without consent (§9.1)", () => {
  it("offers consent with the counts the learner will be shown", () => {
    expect(run(signedIn, hasData)).toEqual({
      session: { status: "signed-in", userId: ACCOUNT_A },
      flow: { name: "ready-for-consent", counts: COUNTS },
    });
  });

  it("has no path into preparing except consent", () => {
    const offered = run(signedIn, hasData);
    const others: GuestMergeEvent[] = [
      { type: "snapshot-collected" },
      { type: "upload-finalising" },
      succeeded,
      { type: "rebase-succeeded" },
      { type: "retry" },
      { type: "upload-progress", progress: { chunksSent: 1, chunksTotal: 2, acceptedItems: 5 } }, // prettier-ignore
    ];
    for (const event of others) {
      expect(guestMergeReducer(offered, event).flow.name).not.toBe("preparing");
    }
    expect(guestMergeReducer(offered, { type: "consented" }).flow.name).toBe(
      "preparing",
    );
  });

  it("refuses consent with no account resolved", () => {
    const orphaned = at(
      { name: "ready-for-consent", counts: COUNTS },
      { status: "signed-out" },
    );
    expect(guestMergeReducer(orphaned, { type: "consented" })).toEqual(
      orphaned,
    );
  });

  it("keeps Not now non-destructive and the offer available afterwards", () => {
    const deferred = run(signedIn, hasData, { type: "deferred" });
    expect(deferred.flow).toEqual({ name: "deferred", counts: COUNTS });
    expect(canStartGuestMerge(deferred)).toBe(true);
    expect(guestMergeReducer(deferred, { type: "consented" }).flow.name).toBe(
      "preparing",
    );
  });

  it("keeps a deferred offer deferred when a later check refreshes the counts", () => {
    // Studying more is not a reason to ask again — only a reason for the number
    // on the deferred entry point to be current.
    const more = { ...COUNTS, attempts: 30 };
    const state = run(
      signedIn,
      hasData,
      { type: "deferred" },
      {
        type: "guest-data-checked",
        counts: more,
        meaningful: true,
      },
    );
    expect(state.flow).toEqual({ name: "deferred", counts: more });
  });

  it("ignores Not now once an upload has begun — there is nothing to defer", () => {
    const uploading = run(signedIn, hasData, { type: "consented" }, { type: "snapshot-collected" }); // prettier-ignore
    expect(guestMergeReducer(uploading, { type: "deferred" }).flow.name).toBe(
      "uploading",
    );
  });
});

describe("duplicate submissions are disabled while active (§19)", () => {
  it("ignores a second consent from every active state", () => {
    const active: GuestMergeFlow[] = [
      { name: "preparing" },
      { name: "uploading", progress: { chunksSent: 1, chunksTotal: 3, acceptedItems: 9 } }, // prettier-ignore
      { name: "finalising" },
      { name: "rebasing", attempt: 0, summary: SUMMARY, changedAnything: true },
    ];
    for (const flow of active) {
      const state = at(flow);
      expect(isGuestMergeActive(state)).toBe(true);
      expect(canStartGuestMerge(state)).toBe(false);
      expect(guestMergeReducer(state, { type: "consented" })).toEqual(state);
    }
  });

  it("does not let a late guest-data check disturb a running merge", () => {
    // The check is asynchronous and can land after consent. Applying it would
    // drag the screen back to a consent prompt for data already in flight.
    const uploading = run(signedIn, hasData, { type: "consented" }, { type: "snapshot-collected" }); // prettier-ignore
    expect(guestMergeReducer(uploading, hasData)).toEqual(uploading);
  });

  it("does not let a late guest-data check reopen a finished merge", () => {
    const done = run(...throughUpload(), { type: "rebase-succeeded" });
    expect(done.flow.name).toBe("completed");
    expect(guestMergeReducer(done, hasData)).toEqual(done);
  });
});

describe("success is claimed last (§20, §29)", () => {
  it("goes to rebasing, not completed, when the server says applied", () => {
    // Finalisation dropped the local component projections, so the learner is
    // missing cards until the authoritative pull lands. Saying "completed" here
    // would be a claim about the device that is not yet true.
    expect(run(...throughUpload()).flow).toEqual({
      name: "rebasing",
      attempt: 0,
      summary: SUMMARY,
      changedAnything: true,
    });
  });

  it("completes only once the rebase lands", () => {
    expect(run(...throughUpload(), { type: "rebase-succeeded" }).flow).toEqual({
      name: "completed",
      summary: SUMMARY,
    });
  });

  it("calls a repeat that changed nothing a no-op, on the SERVER's word", () => {
    const state = run(
      signedIn,
      hasData,
      { type: "consented" },
      { type: "snapshot-collected" },
      {
        type: "upload-succeeded",
        summary: { ...SUMMARY, kind: "no_op" },
        changedAnything: false,
      },
      { type: "rebase-succeeded" },
    );
    expect(state.flow.name).toBe("completed-no-op");
  });

  it("retries the rebase a bounded number of times", () => {
    let state = run(...throughUpload());
    for (let i = 1; i < MAX_REBASE_ATTEMPTS; i += 1) {
      state = guestMergeReducer(state, { type: "rebase-failed" });
      expect(state.flow).toMatchObject({ name: "rebasing", attempt: i });
    }
    state = guestMergeReducer(state, { type: "rebase-failed" });
    expect(state.flow).toMatchObject({
      name: "retryable-error",
      reason: { kind: "rebase-failed" },
      summary: SUMMARY,
    });
  });

  it("never reports completed when the rebase gave up", () => {
    let state = run(...throughUpload());
    for (let i = 0; i < MAX_REBASE_ATTEMPTS; i += 1) {
      state = guestMergeReducer(state, { type: "rebase-failed" });
    }
    expect(state.flow.name).not.toBe("completed");
    expect(state.flow.name).not.toBe("completed-no-op");
    // And it says what DID happen, so the retry prompt is not a blank one.
    expect(state.flow).toHaveProperty("summary", SUMMARY);
  });

  it("retries only the PULL after a rebase gave up, not the whole merge", () => {
    // REL-003-T14a. Finalisation has already re-keyed the guest rows, so
    // re-collecting a snapshot would produce a near-empty one and spend a full
    // begin/finalize round trip getting back to the pull that was the only
    // thing outstanding.
    let state = run(...throughUpload());
    for (let i = 0; i < MAX_REBASE_ATTEMPTS; i += 1) {
      state = guestMergeReducer(state, { type: "rebase-failed" });
    }
    expect(guestMergeReducer(state, { type: "retry" }).flow).toEqual({
      name: "rebasing",
      attempt: 0,
      summary: SUMMARY,
      changedAnything: true,
    });
  });
});

describe("stopping honestly", () => {
  it("treats an interruption as retryable and restarts the whole merge", () => {
    // Nothing was finalised, so the snapshot still describes real guest rows —
    // here re-entering `preparing` IS the right recovery.
    const state = run(
      signedIn,
      hasData,
      { type: "consented" },
      { type: "snapshot-collected" },
      {
        type: "upload-interrupted",
        reason: { kind: "transport", failure: "network" },
      },
    );
    expect(state.flow).toMatchObject({ name: "retryable-error" });
    expect(canStartGuestMerge(state)).toBe(true);
    expect(guestMergeReducer(state, { type: "retry" }).flow.name).toBe(
      "preparing",
    );
  });

  it("treats a server refusal as needing attention, and refuses to retry it", () => {
    // Retrying would resend a history the server already refused for a reason
    // no repetition changes.
    const state = run(
      signedIn,
      hasData,
      { type: "consented" },
      { type: "snapshot-collected" },
      {
        type: "upload-rejected",
        reason: { kind: "server", reasonCode: "snapshot_mismatch" },
      },
    );
    expect(state.flow).toMatchObject({
      name: "attention-required",
      reason: { kind: "server", reasonCode: "snapshot_mismatch" },
    });
    expect(canStartGuestMerge(state)).toBe(false);
    expect(guestMergeReducer(state, { type: "retry" })).toEqual(state);
  });

  it("treats an oversized history as needing attention, having sent nothing", () => {
    const state = run(
      signedIn,
      hasData,
      { type: "consented" },
      {
        type: "snapshot-too-large",
      },
    );
    expect(state.flow).toEqual({
      name: "attention-required",
      reason: { kind: "snapshot-too-large" },
    });
  });
});

describe("the reducer never throws and never invents a state", () => {
  it("answers every (state, event) pair with a valid state", () => {
    // NOT a claim that every pair leaves the state unchanged — many pairs are
    // real transitions, and the tests above pin those. What this proves is that
    // the reducer is total: a late acknowledgement arriving after the learner
    // navigated on cannot crash a merge screen or produce a state name the UI
    // has no branch for.
    const flows: GuestMergeFlow[] = [
      { name: "checking" },
      { name: "no-guest-data" },
      { name: "ready-for-consent", counts: COUNTS },
      { name: "deferred", counts: COUNTS },
      { name: "preparing" },
      { name: "uploading", progress: { chunksSent: 0, chunksTotal: 1, acceptedItems: 0 } }, // prettier-ignore
      { name: "finalising" },
      { name: "rebasing", attempt: 1, summary: SUMMARY, changedAnything: true },
      { name: "completed", summary: SUMMARY },
      { name: "completed-no-op", summary: SUMMARY },
      { name: "retryable-error", reason: { kind: "local" } },
      { name: "attention-required", reason: { kind: "local" } },
    ];
    const events: GuestMergeEvent[] = [
      signedIn,
      signedOut,
      { type: "session-resolved", userId: ACCOUNT_B },
      hasData,
      { type: "guest-data-checked", counts: COUNTS, meaningful: false },
      { type: "consented" },
      { type: "deferred" },
      { type: "snapshot-collected" },
      { type: "snapshot-too-large" },
      { type: "upload-progress", progress: { chunksSent: 1, chunksTotal: 1, acceptedItems: 1 } }, // prettier-ignore
      { type: "upload-finalising" },
      succeeded,
      { type: "upload-interrupted", reason: { kind: "local" } },
      { type: "upload-rejected", reason: { kind: "local" } },
      { type: "rebase-failed" },
      { type: "rebase-succeeded" },
      { type: "retry" },
    ];
    const names = new Set(flows.map((f) => f.name));
    const sessions: GuestMergeSession[] = [
      { status: "unresolved" },
      { status: "signed-out" },
      { status: "signed-in", userId: ACCOUNT_A },
    ];
    for (const session of sessions) {
      for (const flow of flows) {
        for (const event of events) {
          const next = guestMergeReducer(at(flow, session), event);
          expect(names.has(next.flow.name)).toBe(true);
        }
      }
    }
  });

  it("never reaches an active state from a signed-out machine", () => {
    // The strongest single statement of rule 1: with nobody signed in, no event
    // sequence can start a merge.
    const events: GuestMergeEvent[] = [
      hasData,
      { type: "consented" },
      { type: "snapshot-collected" },
      { type: "upload-finalising" },
      succeeded,
      { type: "retry" },
    ];
    let state = run(signedOut);
    for (const event of events) {
      state = guestMergeReducer(state, event);
      expect(isGuestMergeActive(state)).toBe(false);
    }
  });
});
