/**
 * Phase 17 §21 — the honest post-merge summary.
 *
 * PURE: no Dexie, no React, no network. It turns the server's counts plus what
 * the client itself could not send into the small set of facts the UI renders,
 * and it exists as its own module because the temptation it resists is a
 * presentation-layer one: a merge screen naturally wants to report a big
 * encouraging number, and the true number is often smaller.
 *
 * THE RULES IT ENFORCES.
 *
 *  - **The server decides whether anything was applied.** This module never
 *    recomputes `applied` vs `no_op` from the counts; it renders the result the
 *    server sent. A second implementation of that decision is a second answer
 *    waiting to disagree with the first (CLAUDE.md §7).
 *  - **Applied is not the same as sent.** A learner told "42 reviews merged"
 *    when 40 were duplicates of history the account already had has been given a
 *    number that is not true of anything. Applied, duplicate and rejected stay
 *    separate all the way to the screen.
 *  - **Locally skipped records count as needing attention.** `collectGuestSnapshot`
 *    drops records that cannot legally cross the wire. They are still the
 *    learner's data and they did not arrive, so a summary that only reports what
 *    the server saw would silently under-count what was lost (§20.12 — preserve
 *    what was rejected, with an honest recovery path).
 *  - **No internal identifiers.** Counts only: never an event id, a natural key,
 *    an audit detail or a rejection payload (§21, §30).
 */
import type {
  GuestMergeResult,
  GuestMergeSummary,
} from "@/modules/sync/protocol";

import type { GuestSnapshotSkips } from "./guest-snapshot";

/** Which of §21's four outcomes this merge was. */
export type GuestMergeOutcomeKind =
  /** Something the learner would recognise as theirs moved onto the account. */
  | "applied"
  /** Ran to completion and changed nothing — a repeat, not a second success. */
  | "no_op"
  /** Accepted in part; the rest is still to come under the same import key. */
  | "partial"
  /** Refused. Nothing to retry without a change the learner has to make. */
  | "rejected";

/**
 * The counts the summary UI renders. Every field is a number the learner could
 * verify by looking at their own data.
 */
export type GuestMergeSummaryView = {
  kind: GuestMergeOutcomeKind;
  attemptsImported: number;
  eventsImported: number;
  componentsUpdated: number;
  bookmarksAdded: number;
  listsCreated: number;
  listsCombined: number;
  settingsFilled: number;
  /** Records the account already had — the honest "nothing to do" bucket. */
  alreadyPresent: number;
  /**
   * Records that did not make it: refused by the server plus those this device
   * could not legally send. One number, because the learner's question is "did
   * anything not come across?", not "at which layer did it stop?".
   */
  needingAttention: number;
};

const ZERO_SKIPS: GuestSnapshotSkips = {
  events: 0,
  attempts: 0,
  bookmarks: 0,
  lists: 0,
  settings: 0,
};

function totalSkips(skips: GuestSnapshotSkips): number {
  return (
    skips.events +
    skips.attempts +
    skips.bookmarks +
    skips.lists +
    skips.settings
  );
}

/** Everything the account already had, across kinds. */
export function alreadyPresentCount(summary: GuestMergeSummary): number {
  return (
    summary.attemptsDuplicate +
    summary.eventsDuplicate +
    summary.bookmarksAlreadyPresent +
    summary.settingsKeptFromAccount
  );
}

/** Everything refused by the server, across kinds. */
export function serverRejectedCount(summary: GuestMergeSummary): number {
  return (
    summary.attemptsRejected +
    summary.eventsRejected +
    summary.bookmarksRejected +
    summary.listsRejected +
    summary.settingsRejected
  );
}

export type GuestMergeSummaryInput = {
  summary: GuestMergeSummary;
  /**
   * The server's own `finalize.result`. Present only when finalisation
   * concluded; absent for an interrupted or refused run.
   *
   * DELIBERATELY NOT RE-DERIVED HERE (ARCH-001). The applied-vs-no-op decision
   * is the server's — it makes it with `summaryChangedAnything` over the
   * authoritative counts and sends the answer on the wire. An earlier version of
   * this module recomputed it from the same counts and had already drifted (it
   * checked `componentsAffected`, which the protocol's version does not), so a
   * screen could have said "applied" while the wire said `no_op`. That is
   * exactly the contradiction §21 and §29 exist to prevent, and CLAUDE.md §7
   * makes the server the authority regardless.
   */
  serverResult?: Extract<GuestMergeResult, "applied" | "no_op">;
  /** Set when the merge was refused outright. */
  rejected?: boolean;
  /** What this device could not send. Absent when no snapshot was collected. */
  skipped?: GuestSnapshotSkips;
};

/**
 * Build the view §21 requires from what actually happened.
 *
 * The outcomes are decided in a fixed order — refused, then unfinished, then
 * whatever the server said — because they are not mutually exclusive in the raw
 * counts: an interrupted merge can have applied plenty, and calling that
 * "applied" would tell the learner the merge is over when it is not.
 */
export function buildGuestMergeSummaryView(
  input: GuestMergeSummaryInput,
): GuestMergeSummaryView {
  const { summary } = input;
  const skipped = input.skipped ?? ZERO_SKIPS;

  const kind: GuestMergeOutcomeKind = input.rejected
    ? "rejected"
    : (input.serverResult ?? "partial");

  return {
    kind,
    attemptsImported: summary.attemptsApplied,
    eventsImported: summary.eventsApplied,
    componentsUpdated: summary.componentsAffected,
    bookmarksAdded: summary.bookmarksAdded,
    listsCreated: summary.listsCreated,
    listsCombined: summary.listsMerged,
    settingsFilled: summary.settingsAdopted,
    alreadyPresent: alreadyPresentCount(summary),
    needingAttention: serverRejectedCount(summary) + totalSkips(skipped),
  };
}
