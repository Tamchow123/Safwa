/**
 * Phase 17 §19, §21 — whether the merge SURFACE is showing.
 *
 * PURE: no React, no DOM. Extracted from the provider (REL-002-T15) so the one
 * piece of presentation state the merge has can be tested the way the machine
 * is — by calling a function through a sequence — rather than verified by
 * reading it. It is small, and it was wrong twice.
 *
 * The question it answers is not "what happened to the merge" (that is the
 * machine's) but "has the learner already closed the thing that says so". Those
 * differ because the terminal states are terminal: `completed` never leaves
 * itself, so without a memory of the dismissal the summary would reappear on
 * every render, and with the wrong memory a LATER merge's summary is suppressed
 * by an earlier one's dismissal.
 */
import type { GuestMergeState } from "./guest-merge-machine";

/**
 * What the surface remembers. `forSession` is the account the dismissal was
 * recorded under, so an identity change can invalidate it.
 */
export type GuestMergeSurfaceMemory = {
  dismissedKey: string | null;
  forSession: string | null;
};

export function initialSurfaceMemory(): GuestMergeSurfaceMemory {
  return { dismissedKey: null, forSession: null };
}

/**
 * Identifies the surface a dismissal closed: whose merge, and which state.
 *
 * Account-qualified so one learner's dismissal can never match another's
 * surface even for the instant before {@link forgetOnIdentityChange} clears it.
 */
export function surfaceKey(state: GuestMergeState): string {
  const owner =
    state.session.status === "signed-in" ? state.session.userId : "";
  return `${owner}:${state.flow.name}`;
}

/** Record that the learner closed the surface `state` is currently showing. */
export function rememberDismissal(
  state: GuestMergeState,
  userId: string | null,
): GuestMergeSurfaceMemory {
  return { dismissedKey: surfaceKey(state), forSession: userId };
}

/**
 * Forget the dismissal when the identity changes AT ALL — a different account,
 * or the same one signing out and back in.
 *
 * Both matter, and they were fixed in that order. Account-qualifying the key
 * alone left a learner who signs out, studies more as a guest, and signs back in
 * to merge again with their second summary suppressed by their first dismissal:
 * both merges are called `completed`, under the same account. Since the
 * sign-out passes through `null`, comparing the identity catches it.
 *
 * Returns the memory unchanged when nothing changed, so a caller adjusting
 * state during render does not loop.
 */
export function forgetOnIdentityChange(
  memory: GuestMergeSurfaceMemory,
  userId: string | null,
): GuestMergeSurfaceMemory {
  if (memory.forSession === userId) return memory;
  return { dismissedKey: null, forSession: userId };
}

/** Whether the surface for `state` should be shown. */
export function isSurfaceVisible(
  memory: GuestMergeSurfaceMemory,
  state: GuestMergeState,
): boolean {
  return memory.dismissedKey !== surfaceKey(state);
}
