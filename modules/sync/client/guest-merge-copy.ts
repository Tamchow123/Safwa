/**
 * Phase 17 §19, §21, §25, §30 — what the merge UI SAYS, as data.
 *
 * PURE: no React, no DOM. Every user-facing string the merge can show lives
 * here, which is what makes two of the spec's requirements testable rather than
 * merely intended:
 *
 *  - **No raw internal identifiers** (§21, §30). Event ids, natural keys, import
 *    keys, audit details and rejection payloads must never reach the screen. A
 *    reason code is an enumerated token, not a payload, and it is translated
 *    HERE into a sentence rather than rendered — a test can assert that every
 *    string this module can produce is drawn from a fixed set.
 *  - **Honesty about what happened** (§21). "Merged" and "already there" are
 *    different words for different numbers, and a partial merge must not borrow
 *    the completed one's sentence.
 *
 * The copy is deliberately plain. A learner in the middle of losing or keeping
 * their own study history is not the audience for a cheerful noun phrase.
 */
import type { GuestDataSummary } from "./guest-snapshot";
import type {
  GuestMergeState,
  GuestMergeStopReason,
} from "./guest-merge-machine";
import type { GuestMergeSummaryView } from "./guest-merge-summary";

/** One line of the pre-merge or post-merge count list. */
export type GuestMergeCountLine = { label: string; value: number };

/** Everything the dialog renders for the current state. */
export type GuestMergeCopy = {
  /** The dialog's accessible name. */
  title: string;
  /** One or two sentences under the title. */
  body: string;
  /** Counts to list, already filtered to the non-zero ones worth showing. */
  counts: GuestMergeCountLine[];
  /** The primary action's label, or null when there is no primary action. */
  primaryLabel: string | null;
  /** Whether the flow is one the learner can dismiss without losing anything. */
  dismissible: boolean;
  /**
   * What a screen reader should be told when this state arrives. `polite` for
   * progress, `assertive` for a stop the learner has to act on (§19 "use
   * appropriate dialog/alert/live-region semantics").
   */
  liveness: "polite" | "assertive" | "off";
};

/** Pre-merge counts, §19 "show useful counts before confirmation". */
export function preMergeCounts(
  counts: GuestDataSummary,
): GuestMergeCountLine[] {
  return [
    { label: "Words studied", value: counts.components },
    { label: "Reviews", value: counts.events },
    { label: "Answers", value: counts.attempts },
    { label: "Bookmarks", value: counts.bookmarks },
    { label: "Lists", value: counts.lists },
  ].filter((line) => line.value > 0);
}

/**
 * Post-merge counts, §21. Zeroes are dropped EXCEPT the two that are meaningful
 * at zero — "already there" and "needs attention" answer questions the learner
 * is actually asking, and omitting them because they are zero would leave the
 * good news implied rather than said.
 */
export function postMergeCounts(
  summary: GuestMergeSummaryView,
): GuestMergeCountLine[] {
  const applied: GuestMergeCountLine[] = [
    { label: "Words updated", value: summary.componentsUpdated },
    { label: "Reviews merged", value: summary.eventsImported },
    { label: "Answers merged", value: summary.attemptsImported },
    { label: "Bookmarks added", value: summary.bookmarksAdded },
    { label: "Lists created", value: summary.listsCreated },
    { label: "Lists combined", value: summary.listsCombined },
    { label: "Settings filled in", value: summary.settingsFilled },
  ].filter((line) => line.value > 0);
  return [
    ...applied,
    { label: "Already on your account", value: summary.alreadyPresent },
    { label: "Needs attention", value: summary.needingAttention },
  ];
}

/**
 * A sentence for why the merge stopped. Every branch returns a fixed string —
 * the reason code is never rendered, and nothing from the server's payload
 * reaches the screen (§30).
 */
export function stopReasonMessage(reason: GuestMergeStopReason): string {
  switch (reason.kind) {
    case "transport":
      return reason.failure === "network"
        ? "Your device lost its connection before the merge finished."
        : "The server could not be reached to finish the merge.";
    case "server":
      switch (reason.reasonCode) {
        case "email_unverified":
          return "Verify your email address, then try the merge again.";
        case "merge_disabled":
          return "Merging is turned off at the moment. Your local progress is untouched.";
        case "snapshot_mismatch":
          return "Your local progress changed while the merge was running. Start it again to include the newer work.";
        case "cross_account_import":
          return "That merge belongs to a different account and cannot be applied here.";
        case "list_ceiling_exceeded":
        case "declared_totals_exceeded":
          return "This device holds more study data than one merge can carry.";
        default:
          return "The merge could not be completed. Your local progress is untouched.";
      }
    case "snapshot-too-large":
      return "This device holds more study data than one merge can carry.";
    case "rebase-failed":
      return "Your progress is saved to your account, but this device could not finish downloading it.";
    case "session-changed":
      return "You signed out, or a different account signed in, before the merge finished.";
    case "local":
      return "Something on this device stopped the merge. Your local progress is untouched.";
  }
}

/**
 * The whole dialog's copy for `state`.
 *
 * `checking` and `no-guest-data` deliberately return no title and no primary
 * action: the UI renders NOTHING in those states, and returning empty copy is
 * how that is expressed rather than a separate "should I render" predicate the
 * caller could forget to consult.
 */
export function guestMergeCopy(state: GuestMergeState): GuestMergeCopy {
  const none: GuestMergeCopy = {
    title: "",
    body: "",
    counts: [],
    primaryLabel: null,
    dismissible: true,
    liveness: "off",
  };
  const { flow } = state;

  switch (flow.name) {
    case "checking":
    case "no-guest-data":
      return none;

    // "Not now" CLOSES the prompt (COMMIT-001 / SEC-001 / REL-001). An earlier
    // version gave `deferred` the same copy as `ready-for-consent`, so
    // declining left the identical modal open with only its decline button
    // removed — the learner's refusal appeared to do nothing, and the one
    // remaining control was "Add to my account". That is a coercive shape
    // whether or not it was meant as one. A deferred offer lives in settings,
    // where the learner goes looking for it, not in a modal they just refused.
    case "deferred":
      return none;

    case "ready-for-consent":
      return {
        title: "Add your earlier progress to this account?",
        body: "You studied on this device before signing in. Adding it keeps that history on your account, on every device you use. Nothing is sent until you choose to add it, and nothing you have on this account is replaced.",
        counts: preMergeCounts(flow.counts),
        primaryLabel: "Add to my account",
        dismissible: true,
        liveness: "off",
      };

    case "preparing":
      return {
        title: "Preparing your progress",
        body: "Gathering what you studied on this device. Nothing has been sent yet.",
        counts: [],
        primaryLabel: null,
        dismissible: false,
        liveness: "polite",
      };

    case "uploading":
      return {
        title: "Adding your progress",
        body:
          flow.progress.chunksTotal > 1
            ? `Sending your history — part ${flow.progress.chunksSent + 1} of ${flow.progress.chunksTotal}.`
            : "Sending your history.",
        counts: [],
        primaryLabel: null,
        dismissible: false,
        liveness: "polite",
      };

    case "finalising":
      return {
        title: "Adding your progress",
        body: "Finishing up on the server.",
        counts: [],
        primaryLabel: null,
        dismissible: false,
        liveness: "polite",
      };

    case "rebasing":
      return {
        title: "Restoring your history",
        body: "Your progress is on your account. Downloading it to this device.",
        counts: [],
        primaryLabel: null,
        dismissible: false,
        liveness: "polite",
      };

    case "completed":
      return {
        title: "Your progress was added",
        body: "Everything below is now on your account and will follow you to other devices.",
        counts: postMergeCounts(flow.summary),
        primaryLabel: "Continue studying",
        dismissible: true,
        liveness: "polite",
      };

    case "completed-no-op":
      // NOT a second success. §21 requires the repeated merge to be told apart
      // from the one that moved something.
      return {
        title: "Nothing left to add",
        body: "Your account already had everything this device was holding.",
        counts: postMergeCounts(flow.summary),
        primaryLabel: "Continue studying",
        dismissible: true,
        liveness: "polite",
      };

    case "retryable-error":
      return {
        title: "The merge did not finish",
        body: `${stopReasonMessage(flow.reason)} You can try again — anything already added will not be added twice.`,
        counts: flow.summary ? postMergeCounts(flow.summary) : [],
        primaryLabel: "Try again",
        dismissible: true,
        liveness: "assertive",
      };

    case "attention-required":
      return {
        title: "The merge could not be completed",
        body: stopReasonMessage(flow.reason),
        counts: [],
        // No retry: trying again cannot change this outcome, and offering the
        // button anyway would be the dishonest kind of hope.
        primaryLabel: null,
        dismissible: true,
        liveness: "assertive",
      };
  }
}
