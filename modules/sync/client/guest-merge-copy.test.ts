import { describe, expect, it } from "vitest";

import {
  GUEST_MERGE_REASON_CODES,
  type GuestMergeReasonCode,
} from "@/modules/sync/protocol";

import {
  guestMergeCopy,
  postMergeCounts,
  preMergeCounts,
  stopReasonMessage,
} from "./guest-merge-copy";
import type {
  GuestMergeFlow,
  GuestMergeState,
  GuestMergeStopReason,
} from "./guest-merge-machine";
import type { GuestMergeSummaryView } from "./guest-merge-summary";

const COUNTS_FIXTURE = {
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
  alreadyPresent: 5,
  needingAttention: 0,
};

function at(flow: GuestMergeFlow): GuestMergeState {
  return { session: { status: "signed-in", userId: "u1" }, flow };
}

const ALL_FLOWS: GuestMergeFlow[] = [
  { name: "checking" },
  { name: "no-guest-data" },
  { name: "ready-for-consent", counts: { components: 4, events: 12, attempts: 12, bookmarks: 3, lists: 1 } }, // prettier-ignore
  { name: "deferred", counts: { components: 4, events: 12, attempts: 12, bookmarks: 3, lists: 1 } }, // prettier-ignore
  { name: "preparing" },
  { name: "uploading", progress: { chunksSent: 1, chunksTotal: 3, acceptedItems: 9 } }, // prettier-ignore
  { name: "finalising" },
  { name: "rebasing", attempt: 0, summary: SUMMARY, changedAnything: true },
  { name: "completed", summary: SUMMARY },
  { name: "completed-no-op", summary: { ...SUMMARY, kind: "no_op" } },
  { name: "retryable-error", reason: { kind: "rebase-failed" }, summary: SUMMARY }, // prettier-ignore
  { name: "attention-required", reason: { kind: "session-changed" } },
];

describe("no internal identifier ever reaches the screen (§21, §30)", () => {
  it("produces no reason code, uuid, key or bracketed token in any state", () => {
    // The strings are the whole surface, so this can be checked exhaustively
    // rather than trusted. A reason code is a machine token: translated here,
    // never rendered.
    const codes = new Set<string>(GUEST_MERGE_REASON_CODES);
    for (const flow of ALL_FLOWS) {
      const copy = guestMergeCopy(at(flow));
      const text = [copy.title, copy.body, ...copy.counts.map((c) => c.label)]
        .join(" ")
        .toLowerCase();
      for (const code of codes) {
        expect(text).not.toContain(code);
      }
      // No uuid, no 64-hex snapshot hash, no snake_case token at all.
      expect(text).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
      expect(text).not.toMatch(/[0-9a-f]{32,}/);
      expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });

  it("has a sentence for every enumerated server reason code", () => {
    // A code with no sentence would fall through to a default that says less
    // than it could; this pins that every one was considered.
    for (const reasonCode of GUEST_MERGE_REASON_CODES) {
      const message = stopReasonMessage({
        kind: "server",
        reasonCode: reasonCode as GuestMergeReasonCode,
      });
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(reasonCode);
    }
  });

  it("has a sentence for every stop-reason kind", () => {
    const kinds: GuestMergeStopReason[] = [
      { kind: "transport", failure: "network" },
      { kind: "transport", failure: "server_error" },
      { kind: "server", reasonCode: "internal_error" },
      { kind: "snapshot-too-large" },
      { kind: "rebase-failed" },
      { kind: "session-changed" },
      { kind: "local" },
    ];
    for (const reason of kinds) {
      expect(stopReasonMessage(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("what the dialog offers", () => {
  it("says nothing at all while checking or with no guest data", () => {
    // An empty title is the single "render nothing" signal, so the component
    // cannot forget a second predicate.
    expect(guestMergeCopy(at({ name: "checking" })).title).toBe("");
    expect(guestMergeCopy(at({ name: "no-guest-data" })).title).toBe("");
  });

  it("says nothing once the learner has deferred", () => {
    // The decline closes the prompt; the offer lives in settings afterwards.
    expect(
      guestMergeCopy(at({ name: "deferred", counts: COUNTS_FIXTURE })).title,
    ).toBe("");
  });

  it("announces both completions politely", () => {
    expect(guestMergeCopy(at({ name: "completed", summary: SUMMARY })).liveness).toBe("polite"); // prettier-ignore
    expect(guestMergeCopy(at({ name: "completed-no-op", summary: SUMMARY })).liveness).toBe("polite"); // prettier-ignore
  });

  it("shows pre-merge counts before consent, dropping the empty kinds", () => {
    const copy = guestMergeCopy(
      at({
        name: "ready-for-consent",
        counts: { components: 4, events: 12, attempts: 12, bookmarks: 0, lists: 0 }, // prettier-ignore
      }),
    );
    expect(copy.counts.map((c) => c.label)).toEqual([
      "Words studied",
      "Reviews",
      "Answers",
    ]);
    expect(copy.primaryLabel).toBe("Add to my account");
  });

  it("promises that nothing is sent and nothing is replaced", () => {
    // §9.1 and §16-§18, in the only place the learner will read them.
    const copy = guestMergeCopy(
      at({
        name: "ready-for-consent",
        counts: { components: 1, events: 1, attempts: 1, bookmarks: 0, lists: 0 }, // prettier-ignore
      }),
    );
    expect(copy.body).toContain("Nothing is sent until you choose");
    expect(copy.body).toContain("nothing you have on this account is replaced");
  });

  it("cannot be dismissed while the merge is running", () => {
    for (const name of ["preparing", "uploading", "finalising", "rebasing"]) {
      const flow = ALL_FLOWS.find((f) => f.name === name)!;
      expect(guestMergeCopy(at(flow)).dismissible).toBe(false);
      expect(guestMergeCopy(at(flow)).primaryLabel).toBeNull();
    }
  });

  it("names the part being sent only when there is more than one", () => {
    expect(
      guestMergeCopy(at({ name: "uploading", progress: { chunksSent: 1, chunksTotal: 3, acceptedItems: 9 } })).body, // prettier-ignore
    ).toContain("part 2 of 3");
    expect(
      guestMergeCopy(at({ name: "uploading", progress: { chunksSent: 0, chunksTotal: 1, acceptedItems: 0 } })).body, // prettier-ignore
    ).not.toContain("part");
  });
});

describe("what the dialog says afterwards (§21)", () => {
  it("tells a completed merge apart from a repeated one", () => {
    const applied = guestMergeCopy(at({ name: "completed", summary: SUMMARY }));
    const noop = guestMergeCopy(
      at({ name: "completed-no-op", summary: { ...SUMMARY, kind: "no_op" } }),
    );
    expect(applied.title).not.toBe(noop.title);
    expect(noop.title).toBe("Nothing left to add");
  });

  it("keeps 'already there' and 'needs attention' even at zero", () => {
    // They answer questions the learner is asking. Dropping them because they
    // are zero leaves the good news implied rather than said.
    const counts = postMergeCounts({
      ...SUMMARY,
      alreadyPresent: 0,
      needingAttention: 0,
    });
    expect(counts.map((c) => c.label)).toContain("Already on your account");
    expect(counts.map((c) => c.label)).toContain("Needs attention");
  });

  it("drops applied counts that are zero", () => {
    const counts = postMergeCounts({ ...SUMMARY, listsCombined: 0 });
    expect(counts.map((c) => c.label)).not.toContain("Lists combined");
  });

  it("offers a retry only where retrying could work", () => {
    expect(
      guestMergeCopy(at({ name: "retryable-error", reason: { kind: "local" } }))
        .primaryLabel,
    ).toBe("Try again");
    // Offering it here would be the dishonest kind of hope.
    expect(
      guestMergeCopy(
        at({ name: "attention-required", reason: { kind: "session-changed" } }),
      ).primaryLabel,
    ).toBeNull();
  });

  it("shows what a partial merge DID achieve alongside the retry", () => {
    const copy = guestMergeCopy(
      at({
        name: "retryable-error",
        reason: { kind: "rebase-failed" },
        summary: SUMMARY,
      }),
    );
    expect(copy.counts.length).toBeGreaterThan(0);
    expect(copy.body).toContain("will not be added twice");
  });

  it("announces a stop assertively and progress politely (§19)", () => {
    expect(guestMergeCopy(at({ name: "rebasing", attempt: 0, summary: SUMMARY, changedAnything: true })).liveness).toBe("polite"); // prettier-ignore
    expect(guestMergeCopy(at({ name: "retryable-error", reason: { kind: "local" } })).liveness).toBe("assertive"); // prettier-ignore
    expect(guestMergeCopy(at({ name: "attention-required", reason: { kind: "local" } })).liveness).toBe("assertive"); // prettier-ignore
  });
});

describe("preMergeCounts", () => {
  it("drops every zero", () => {
    expect(
      preMergeCounts({ components: 0, events: 0, attempts: 0, bookmarks: 2, lists: 0 }), // prettier-ignore
    ).toEqual([{ label: "Bookmarks", value: 2 }]);
  });
});
