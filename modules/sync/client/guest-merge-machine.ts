/**
 * Phase 17 §19 — the guest→account merge STATE MACHINE.
 *
 * PURE: no React, no Dexie, no fetch, no clock. It answers one question per
 * event — "what is true now?" — and the React provider that owns the effects
 * drives it. That split is the same one `controller.ts` makes for ordinary sync,
 * and for the same reason: every path through a merge, including the ones that
 * only happen when a network dies at an awkward moment, has to be reachable in a
 * unit test by calling a function.
 *
 * THE STATES §19 NAMES, AND WHAT EACH ONE PROMISES.
 *
 *   checking            nothing is known yet — NOT "no guest data", NOT "guest"
 *   no-guest-data       resolved: this device has nothing worth merging
 *   ready-for-consent   resolved: there is data, and NOTHING has been sent
 *   deferred            the learner said "Not now"; the offer stays available
 *   preparing           collecting the snapshot; still nothing sent
 *   uploading           chunks in flight
 *   finalising          the server is concluding the import
 *   rebasing            pulling the authoritative post-merge state
 *   completed           applied, and locally durable
 *   completed-no-op     ran to completion and changed nothing (a repeat)
 *   retryable-error     stopped, and trying again could work
 *   attention-required  stopped, and trying again could not
 *
 * FOUR RULES THIS MACHINE EXISTS TO ENFORCE.
 *
 *  1. **The machine always knows WHOSE merge this is.** The session is a
 *     three-way `unresolved | signed-out | signed-in`, not a boolean, and no
 *     guest data is acted on until it says `signed-in`. §19 forbids
 *     misclassifying a PENDING session as a guest; a boolean cannot tell
 *     "not answered yet" from "answered: nobody", nor "the same session
 *     re-reporting itself" from "a different learner signed in on this device".
 *     Both of those distinctions turned out to matter: the first would offer a
 *     merge naming counts nobody had counted, and the second would offer
 *     account B the leftovers of account A.
 *  2. **Nothing is sent without consent** (§9.1). The only edge into `preparing`
 *     is `consented`, and it is only accepted from `ready-for-consent` or
 *     `deferred`. There is no automatic path, and no event can skip it.
 *  3. **A second submission while one is active does nothing** (§19 "disable
 *     duplicate submissions while active"). `consented` from any active state is
 *     ignored rather than restarting — this is where the single-flight promise
 *     `guest-merge-upload.ts` documents but deliberately does not enforce is
 *     actually kept.
 *  4. **Success is claimed last, and only once the device has it too.** The
 *     server saying `applied` moves the machine to `rebasing`, not `completed`:
 *     finalisation dropped the local component projections, so until the
 *     authoritative pull lands the learner has cards missing. The pull is retried
 *     a bounded number of times and, if it will not land, the machine reports
 *     `retryable-error` — never `completed` (REL-002, and §29's ban on false
 *     rollback claims read in the other direction).
 */
import type { GuestMergeReasonCode } from "@/modules/sync/protocol";

import type { GuestDataSummary } from "./guest-snapshot";
import type { GuestMergeApiFailure } from "./guest-merge-api";
import type { GuestMergeSummaryView } from "./guest-merge-summary";
import type { GuestMergeProgress } from "./guest-merge-upload";

/**
 * How many times the post-merge pull is retried before the machine stops
 * claiming the merge is finishing. Small: each attempt is a full pull, the
 * learner is watching, and a fourth failure means something the UI should say
 * out loud rather than keep spinning on.
 */
export const MAX_REBASE_ATTEMPTS = 3;

/** Why the merge stopped, in terms the UI can turn into a sentence. */
export type GuestMergeStopReason =
  | { kind: "transport"; failure: GuestMergeApiFailure }
  | { kind: "server"; reasonCode: GuestMergeReasonCode }
  | { kind: "snapshot-too-large" }
  | { kind: "rebase-failed" }
  /** The session went away, or a different account signed in, mid-merge. */
  | { kind: "session-changed" }
  | { kind: "local" };

export type GuestMergeFlow =
  | { name: "checking" }
  | { name: "no-guest-data" }
  | { name: "ready-for-consent"; counts: GuestDataSummary }
  | { name: "deferred"; counts: GuestDataSummary }
  | { name: "preparing" }
  | { name: "uploading"; progress: GuestMergeProgress }
  | { name: "finalising" }
  | {
      name: "rebasing";
      attempt: number;
      /**
       * Carried ACROSS the rebase rather than handed over when it lands. The
       * server already told us what it did; the pull decides only whether the
       * device can show it. Recomputing or re-fetching the summary afterwards
       * would be a second answer to a question already answered.
       */
      summary: GuestMergeSummaryView;
      changedAnything: boolean;
    }
  | { name: "completed"; summary: GuestMergeSummaryView }
  | { name: "completed-no-op"; summary: GuestMergeSummaryView }
  | {
      name: "retryable-error";
      reason: GuestMergeStopReason;
      /** What HAD been applied when it stopped — partial, and labelled so. */
      summary?: GuestMergeSummaryView;
    }
  /**
   * Stopped, and another attempt as-is could not help.
   *
   * Carries no summary, deliberately (REL-004-T14a). For `session-changed` that
   * means a device which still owes a post-merge pull forgets WHICH merge, once
   * the identity churns again — the UX signal is lost, but the data is not:
   * `finaliseGuestMerge` leaves the account's ordinary sync cursor untouched
   * precisely so the next ORDINARY pull restores the dropped component
   * projections whatever this flow remembers. Widening the type for a rare,
   * self-healing case would buy an explanation, not a recovery.
   */
  | { name: "attention-required"; reason: GuestMergeStopReason };

export type GuestMergeFlowName = GuestMergeFlow["name"];

/**
 * The machine's whole state: WHOSE merge this is, and how far it has got.
 *
 * The account is carried rather than a signed-in boolean because a boolean
 * cannot tell "the same session re-asserting itself" from "a different learner
 * signed in on this device", and those need opposite answers: the first must
 * change nothing (a re-render would otherwise wipe a completed summary), the
 * second must restart the flow (or account B is offered account A's leftovers).
 * Both were real defects in the first version of this file.
 */
export type GuestMergeSession =
  /** The auth session has not answered yet. NOT a guest — see rule 1. */
  | { status: "unresolved" }
  /** Answered: nobody is signed in on this device. */
  | { status: "signed-out" }
  | { status: "signed-in"; userId: string };

export type GuestMergeState = {
  /** WHOSE merge this is. */
  session: GuestMergeSession;
  flow: GuestMergeFlow;
};

export type GuestMergeEvent =
  /**
   * The auth session resolved. `userId` is the signed-in account, or `null` for
   * a learner who is genuinely signed out — NEVER for a session still loading,
   * which must simply not dispatch this yet (§19: a pending session must not be
   * misclassified as a guest).
   */
  | { type: "session-resolved"; userId: string | null }
  /** A guest-data check finished. Only meaningful while nothing is in flight. */
  | {
      type: "guest-data-checked";
      counts: GuestDataSummary;
      meaningful: boolean;
    }
  | { type: "consented" }
  | { type: "deferred" }
  | { type: "snapshot-collected" }
  | { type: "snapshot-too-large" }
  | { type: "upload-progress"; progress: GuestMergeProgress }
  | { type: "upload-finalising" }
  /** The server finalised. `result` decides completed vs completed-no-op later. */
  | {
      type: "upload-succeeded";
      summary: GuestMergeSummaryView;
      changedAnything: boolean;
    }
  | { type: "upload-interrupted"; reason: GuestMergeStopReason }
  | { type: "upload-rejected"; reason: GuestMergeStopReason }
  | { type: "rebase-failed" }
  | { type: "rebase-succeeded" }
  | { type: "retry" };

/** The initial state: nobody resolved, nothing assumed (rule 1). */
export function initialGuestMergeState(): GuestMergeState {
  return { session: { status: "unresolved" }, flow: { name: "checking" } };
}

/**
 * States in which a merge is under way. `consented` is ignored here (rule 3),
 * and a fresh guest-data check must not reset the display out from under it.
 */
const ACTIVE: ReadonlySet<GuestMergeFlowName> = new Set([
  "preparing",
  "uploading",
  "finalising",
  "rebasing",
]);

/** Whether a merge is in flight, so the UI can disable its submit control. */
export function isGuestMergeActive(state: GuestMergeState): boolean {
  return ACTIVE.has(state.flow.name);
}

/**
 * Whether the merge can be started (or restarted) from `state`. The UI shows a
 * primary action exactly when this is true, so "the deferred entry point stays
 * available" (§9.1) and "duplicate submissions are disabled" (§19) are one
 * predicate rather than two rules that can disagree.
 */
export function canStartGuestMerge(state: GuestMergeState): boolean {
  // Never without an account to merge INTO — the offer is meaningless, and
  // acting on it would be the misclassification rule 1 exists to prevent.
  if (state.session.status !== "signed-in") return false;
  return (
    state.flow.name === "ready-for-consent" ||
    state.flow.name === "deferred" ||
    state.flow.name === "retryable-error"
  );
}

/**
 * Does a retry from `state` need only the post-merge PULL, rather than the whole
 * merge again?
 *
 * Exported so the caller that has to choose which effect to run asks the same
 * question the reducer answers, instead of re-deriving it (ARCH-001). The two
 * conditions were briefly written twice and already differed — the copy omitted
 * the `summary` check — which is a UI that runs a bare pull while the state it
 * renders says a full upload is under way.
 */
export function needsRebaseOnlyRetry(state: GuestMergeState): boolean {
  const { flow } = state;
  return (
    flow.name === "retryable-error" &&
    flow.reason.kind === "rebase-failed" &&
    flow.summary !== undefined
  );
}

/**
 * Terminal states — the merge is over, for better or worse, and only a fresh
 * guest-data check (a later, separate merge) moves out of them.
 */
const TERMINAL: ReadonlySet<GuestMergeFlowName> = new Set([
  "completed",
  "completed-no-op",
  "attention-required",
]);

/**
 * Is there merge work this device still owes, such that losing the flow silently
 * would hide it? (REL-001-T14a.)
 *
 * The active states, obviously. But ALSO a `retryable-error` that came from an
 * exhausted rebase: the server applied that merge and finalisation already
 * dropped this device's component projections, so the only thing outstanding is
 * a pull — and forgetting that is exactly the half-applied merge this guard
 * exists to keep visible. Every other `retryable-error` sent nothing that stuck,
 * so nothing is owed.
 */
function hasUnfinishedWork(flow: GuestMergeFlow): boolean {
  if (ACTIVE.has(flow.name)) return true;
  return (
    flow.name === "retryable-error" && flow.reason.kind === "rebase-failed"
  );
}

/**
 * The transition function. TOTAL: every (state, event) pair has an answer, and
 * an event that does not apply returns the state UNCHANGED rather than throwing
 * — a merge screen must not crash because a late acknowledgement arrived after
 * the learner navigated on.
 */
export function guestMergeReducer(
  state: GuestMergeState,
  event: GuestMergeEvent,
): GuestMergeState {
  const { session, flow } = state;
  /** Keep the session, move the flow. */
  const to = (next: GuestMergeFlow): GuestMergeState => ({ session, flow: next }); // prettier-ignore

  switch (event.type) {
    case "session-resolved": {
      // The SAME answer re-asserting itself changes nothing. Auth hooks
      // re-report on every render and on every focus; treating each one as news
      // would wipe a completed summary off the screen the moment the learner
      // looked away and back.
      const same =
        event.userId === null
          ? session.status === "signed-out"
          : session.status === "signed-in" && session.userId === event.userId;
      if (same) return state;

      const next: GuestMergeSession =
        event.userId === null
          ? { status: "signed-out" }
          : { status: "signed-in", userId: event.userId };

      // THE IDENTITY CHANGED. Checked once, before either specific case, so the
      // guard cannot be remembered on one path and forgotten on the other —
      // which is precisely what happened when signing out and switching account
      // were handled separately (REL-001-T14a).
      //
      // If this device still owes merge work, say so rather than resetting: the
      // server side may already be durable and finalisation may already have
      // dropped this device's component projections, so a silent reset would
      // hide a half-applied merge behind an ordinary-looking screen. Whoever
      // arrived — nobody, or a different learner — is not the person that work
      // belongs to, and the recovery is outside this flow.
      if (hasUnfinishedWork(flow)) {
        return {
          session: next,
          flow: {
            name: "attention-required",
            reason: { kind: "session-changed" },
          },
        };
      }

      // Nothing outstanding. Everything the flow holds — counts, a consent
      // offer, a finished summary — belongs to the previous identity, so it
      // goes: a signed-out learner is shown nothing, and a newly signed-in one
      // starts in `checking` and waits for a data check of their own.
      return {
        session: next,
        flow: { name: event.userId === null ? "no-guest-data" : "checking" },
      };
    }

    case "guest-data-checked":
      // Rule 1. Without a resolved account there is nothing to merge INTO, and
      // offering to move this data would be a claim about a learner nobody has
      // identified. Checked FIRST, so it holds from every flow state —
      // including `no-guest-data`, which a signed-out learner sits in while
      // their continued guest studying keeps re-firing this check.
      if (session.status !== "signed-in") return state;
      // Never disturbs a merge in flight or one that has finished (rule 3): a
      // check that lands late must not drag a completed merge back to a consent
      // prompt naming data that has already moved.
      //
      // ONE EXCEPTION, and it is not a loophole: an `attention-required` whose
      // reason is `session-changed` is attention owed by the PREVIOUS identity.
      // Without this, the learner who just signed in would inherit a terminal
      // state about somebody else's merge and could never start their own. A
      // check that reaches here has already passed the `signed-in` gate above,
      // so it describes the current account's device.
      const staleForPreviousIdentity =
        flow.name === "attention-required" &&
        flow.reason.kind === "session-changed";
      if (!staleForPreviousIdentity) {
        if (ACTIVE.has(flow.name) || TERMINAL.has(flow.name)) return state;
        if (flow.name === "retryable-error") return state;
      }
      if (!event.meaningful) return to({ name: "no-guest-data" });
      // A deferred offer stays deferred — a re-check is not a reason to ask
      // again, only to keep the counts honest if the learner studied more.
      if (flow.name === "deferred") {
        return to({ name: "deferred", counts: event.counts });
      }
      return to({ name: "ready-for-consent", counts: event.counts });

    case "consented":
      // Rules 1, 2 and 3 in one predicate: only with an account, only from a
      // state where the learner is being offered the merge, never while one is
      // already running.
      return canStartGuestMerge(state) ? to({ name: "preparing" }) : state;

    case "deferred":
      // "Not now" is non-destructive and only meaningful before anything is
      // sent. Once an upload has begun there is nothing to defer.
      return flow.name === "ready-for-consent"
        ? to({ name: "deferred", counts: flow.counts })
        : state;

    case "snapshot-collected":
      return flow.name === "preparing"
        ? to({ name: "uploading", progress: { chunksSent: 0, chunksTotal: 0, acceptedItems: 0 } }) // prettier-ignore
        : state;

    case "snapshot-too-large":
      // Nothing was sent, and no retry helps: the history exceeds what one
      // import may carry, which is a condition only an operator can change.
      return flow.name === "preparing"
        ? to({ name: "attention-required", reason: { kind: "snapshot-too-large" } }) // prettier-ignore
        : state;

    case "upload-progress":
      // Accepted from `preparing` as well as `uploading` because the driver
      // reports its first progress as soon as it knows the chunk count, which
      // can reach the provider before the provider has dispatched
      // `snapshot-collected`. Dropping it would lose the first chunk's progress
      // from the bar; taking it just moves the flow to where it is going anyway.
      return flow.name === "uploading" || flow.name === "preparing"
        ? to({ name: "uploading", progress: event.progress })
        : state;

    case "upload-finalising":
      // Tolerated from `preparing` for the same ordering reason, and for one
      // more: an empty snapshot goes straight from `begin` to `finalize` with
      // no chunk in between, so there may never be an `uploading` step at all.
      return flow.name === "uploading" || flow.name === "preparing"
        ? to({ name: "finalising" })
        : state;

    case "upload-succeeded":
      // NOT `completed` (rule 4). The server is durable but the device is not:
      // finalisation dropped the local projections, so the learner is missing
      // cards until the authoritative pull lands.
      if (!ACTIVE.has(flow.name)) return state;
      return to({
        name: "rebasing",
        attempt: 0,
        summary: event.summary,
        changedAnything: event.changedAnything,
      });

    case "rebase-succeeded":
      if (flow.name !== "rebasing") return state;
      // Only here is the merge over, and the distinction is the SERVER's: a
      // repeat that changed nothing is a no-op, not a second success.
      return to(
        flow.changedAnything
          ? { name: "completed", summary: flow.summary }
          : { name: "completed-no-op", summary: flow.summary },
      );

    case "rebase-failed": {
      if (flow.name !== "rebasing") return state;
      const attempt = flow.attempt + 1;
      if (attempt < MAX_REBASE_ATTEMPTS) return to({ ...flow, attempt });
      // Bounded, then honest. The merge IS on the server — this is not a
      // failure of the merge — but the device does not have it yet, and saying
      // "completed" while cards are missing is the false claim §29 forbids read
      // in the other direction. The summary rides along so the UI can say what
      // DID happen while it asks for a retry.
      return to({
        name: "retryable-error",
        reason: { kind: "rebase-failed" },
        summary: flow.summary,
      });
    }

    case "upload-interrupted":
      return ACTIVE.has(flow.name)
        ? to({ name: "retryable-error", reason: event.reason })
        : state;

    case "upload-rejected":
      return ACTIVE.has(flow.name)
        ? to({ name: "attention-required", reason: event.reason })
        : state;

    case "retry":
      if (flow.name !== "retryable-error") {
        // Retrying from `attention-required` would resend a history the server
        // already refused, or merge under a session that no longer exists.
        return state;
      }
      // A rebase that gave up needs the PULL again, not the whole merge
      // (REL-003). By this point finalisation has already re-keyed the guest
      // rows, so re-collecting a snapshot would produce a near-empty one and
      // spend a full begin/finalize round trip to get back to the pull that was
      // the only thing outstanding.
      if (needsRebaseOnlyRetry(state) && flow.summary) {
        return to({
          name: "rebasing",
          attempt: 0,
          summary: flow.summary,
          // The server already said what this merge did; the rebase failing
          // afterwards does not unsay it.
          changedAnything: flow.summary.kind !== "no_op",
        });
      }
      return to({ name: "preparing" });
  }
}
