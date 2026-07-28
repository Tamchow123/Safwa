import { describe, expect, it } from "vitest";

import type { GuestMergeFlow, GuestMergeState } from "./guest-merge-machine";
import type { GuestMergeSummaryView } from "./guest-merge-summary";
import {
  forgetOnIdentityChange,
  initialSurfaceMemory,
  isSurfaceVisible,
  rememberDismissal,
  surfaceKey,
  type GuestMergeSurfaceMemory,
} from "./guest-merge-surface";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const SUMMARY: GuestMergeSummaryView = {
  kind: "applied",
  attemptsImported: 1,
  eventsImported: 1,
  componentsUpdated: 1,
  bookmarksAdded: 0,
  listsCreated: 0,
  listsCombined: 0,
  settingsFilled: 0,
  alreadyPresent: 0,
  needingAttention: 0,
};

function signedIn(userId: string, flow: GuestMergeFlow): GuestMergeState {
  return { session: { status: "signed-in", userId }, flow };
}

const COMPLETED: GuestMergeFlow = { name: "completed", summary: SUMMARY };

describe("a dismissal hides exactly the surface it closed", () => {
  it("shows everything before anything is dismissed", () => {
    expect(
      isSurfaceVisible(initialSurfaceMemory(), signedIn(A, COMPLETED)),
    ).toBe(true);
  });

  it("hides the surface the learner closed", () => {
    const memory = rememberDismissal(signedIn(A, COMPLETED), A);
    expect(isSurfaceVisible(memory, signedIn(A, COMPLETED))).toBe(false);
  });

  it("does not hide a DIFFERENT state of the same merge", () => {
    // Dismissing a summary must not also silence a later failure.
    const memory = rememberDismissal(signedIn(A, COMPLETED), A);
    expect(
      isSurfaceVisible(
        memory,
        signedIn(A, { name: "retryable-error", reason: { kind: "local" } }),
      ),
    ).toBe(true);
  });
});

describe("one learner's dismissal never silences another's merge", () => {
  it("does not match a second account's identically-named surface", () => {
    // The shared-device case: both merges are called `completed`.
    const memory = rememberDismissal(signedIn(A, COMPLETED), A);
    expect(isSurfaceVisible(memory, signedIn(B, COMPLETED))).toBe(true);
  });

  it("is forgotten outright when a different account signs in", () => {
    const dismissed = rememberDismissal(signedIn(A, COMPLETED), A);
    const forgotten = forgetOnIdentityChange(dismissed, B);
    expect(forgotten.dismissedKey).toBeNull();
    expect(isSurfaceVisible(forgotten, signedIn(B, COMPLETED))).toBe(true);
  });
});

describe("the same learner merging twice (REL-002 residual)", () => {
  it("shows the second summary after a sign-out and back in", () => {
    // The case the account qualifier alone did NOT close: A dismisses their
    // first summary, signs out, studies more as a guest, signs back in, and
    // merges again. Both merges are `completed`, under the same account — so
    // the key matches and the second summary would never appear.
    let memory: GuestMergeSurfaceMemory = initialSurfaceMemory();
    memory = forgetOnIdentityChange(memory, A);
    memory = rememberDismissal(signedIn(A, COMPLETED), A);
    expect(isSurfaceVisible(memory, signedIn(A, COMPLETED))).toBe(false);

    // Sign out — the identity changed, so the dismissal no longer applies.
    memory = forgetOnIdentityChange(memory, null);
    // ...and back in as the same learner.
    memory = forgetOnIdentityChange(memory, A);

    expect(isSurfaceVisible(memory, signedIn(A, COMPLETED))).toBe(true);
  });

  it("returns the memory UNCHANGED when the identity did not change", () => {
    // The caller adjusts this during render; returning a fresh object every
    // time would loop.
    const memory = rememberDismissal(signedIn(A, COMPLETED), A);
    expect(forgetOnIdentityChange(memory, A)).toBe(memory);
  });
});

describe("surfaceKey", () => {
  it("distinguishes owner and state", () => {
    expect(surfaceKey(signedIn(A, COMPLETED))).not.toBe(
      surfaceKey(signedIn(B, COMPLETED)),
    );
    expect(surfaceKey(signedIn(A, COMPLETED))).not.toBe(
      surfaceKey(signedIn(A, { name: "completed-no-op", summary: SUMMARY })),
    );
  });

  it("gives a signed-out session an owner-less key rather than throwing", () => {
    expect(
      surfaceKey({ session: { status: "signed-out" }, flow: COMPLETED }),
    ).toBe(":completed");
  });
});
