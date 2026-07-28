import { describe, expect, it } from "vitest";

import {
  emptyGuestMergeSummary,
  type GuestMergeSummary,
} from "@/modules/sync/protocol";

import type { GuestSnapshotSkips } from "./guest-snapshot";
import {
  alreadyPresentCount,
  buildGuestMergeSummaryView,
  serverRejectedCount,
} from "./guest-merge-summary";

function summary(
  overrides: Partial<GuestMergeSummary> = {},
): GuestMergeSummary {
  return { ...emptyGuestMergeSummary(), ...overrides };
}

function skips(
  overrides: Partial<GuestSnapshotSkips> = {},
): GuestSnapshotSkips {
  return {
    events: 0,
    attempts: 0,
    bookmarks: 0,
    lists: 0,
    settings: 0,
    ...overrides,
  };
}

describe("the applied/no-op decision is the server's, not this module's", () => {
  it("reports no_op even when counts a client might read as a change are set", () => {
    // ARCH-001: an earlier version re-derived this from the counts and had
    // already drifted from the protocol's `summaryChangedAnything` (it also
    // checked `componentsAffected`). A screen saying "applied" while the wire
    // says `no_op` is exactly the contradiction §21 and §29 forbid, so the
    // server's answer wins even when the counts look otherwise.
    expect(
      buildGuestMergeSummaryView({
        summary: summary({ componentsAffected: 3, listsMerged: 1 }),
        serverResult: "no_op",
      }).kind,
    ).toBe("no_op");
  });

  it("reports applied when the server said applied, whatever the counts show", () => {
    expect(
      buildGuestMergeSummaryView({
        summary: summary(),
        serverResult: "applied",
      }).kind,
    ).toBe("applied");
  });
});

describe("alreadyPresentCount / serverRejectedCount", () => {
  it("adds up what the account already had", () => {
    expect(
      alreadyPresentCount(
        summary({
          attemptsDuplicate: 4,
          eventsDuplicate: 3,
          bookmarksAlreadyPresent: 2,
          settingsKeptFromAccount: 1,
        }),
      ),
    ).toBe(10);
  });

  it("adds up what the server refused across every kind", () => {
    expect(
      serverRejectedCount(
        summary({
          attemptsRejected: 1,
          eventsRejected: 2,
          bookmarksRejected: 3,
          listsRejected: 4,
          settingsRejected: 5,
        }),
      ),
    ).toBe(15);
  });
});

describe("buildGuestMergeSummaryView", () => {
  it("reports applied counts, never sent counts", () => {
    // A learner told "42 reviews merged" when 40 were duplicates has been given
    // a number that is not true of anything.
    const view = buildGuestMergeSummaryView({
      summary: summary({ eventsApplied: 2, eventsDuplicate: 40 }),
      serverResult: "applied",
    });
    expect(view.eventsImported).toBe(2);
    expect(view.alreadyPresent).toBe(40);
  });

  it("calls a merge that changed nothing a no-op, not a success", () => {
    expect(
      buildGuestMergeSummaryView({
        summary: summary({ eventsDuplicate: 12 }),
        serverResult: "no_op",
      }).kind,
    ).toBe("no_op");
  });

  it("calls an unfinished merge partial even when plenty was applied", () => {
    // No `serverResult` means finalisation never concluded. The counts alone
    // would read as a success; saying so would tell the learner the merge is
    // over when the rest is still to come under the same key.
    expect(
      buildGuestMergeSummaryView({
        summary: summary({ eventsApplied: 900, attemptsApplied: 900 }),
      }).kind,
    ).toBe("partial");
  });

  it("calls a refusal rejected even if it is also unfinished", () => {
    expect(
      buildGuestMergeSummaryView({
        summary: summary(),
        rejected: true,
      }).kind,
    ).toBe("rejected");
  });

  it("treats a refusal as rejected even when a stale server result is present", () => {
    // `rejected` is checked first deliberately: a refusal that also carried a
    // result must never render as the success that result names.
    expect(
      buildGuestMergeSummaryView({
        summary: summary(),
        serverResult: "applied",
        rejected: true,
      }).kind,
    ).toBe("rejected");
  });

  it("counts records this device could not send as needing attention", () => {
    // They are still the learner's data and they did not arrive. A summary that
    // only reports what the server saw would under-count what was lost.
    const view = buildGuestMergeSummaryView({
      summary: summary({ eventsRejected: 2 }),
      serverResult: "applied",
      skipped: skips({ events: 3, attempts: 3, lists: 1 }),
    });
    expect(view.needingAttention).toBe(9);
  });

  it("treats an absent skip record as nothing skipped", () => {
    expect(
      buildGuestMergeSummaryView({
        summary: summary(),
        serverResult: "applied",
      }).needingAttention,
    ).toBe(0);
  });

  it("exposes no identifier, key or payload — only counts", () => {
    const view = buildGuestMergeSummaryView({
      summary: summary({ eventsApplied: 1 }),
      serverResult: "applied",
      skipped: skips({ events: 1 }),
    });
    for (const [key, value] of Object.entries(view)) {
      if (key === "kind") continue;
      expect(typeof value).toBe("number");
    }
  });

  it("maps every count to the field §21 names for it", () => {
    expect(
      buildGuestMergeSummaryView({
        summary: summary({
          attemptsApplied: 1,
          eventsApplied: 2,
          componentsAffected: 3,
          bookmarksAdded: 4,
          listsCreated: 5,
          listsMerged: 6,
          settingsAdopted: 7,
        }),
        serverResult: "applied",
      }),
    ).toEqual({
      kind: "applied",
      attemptsImported: 1,
      eventsImported: 2,
      componentsUpdated: 3,
      bookmarksAdded: 4,
      listsCreated: 5,
      listsCombined: 6,
      settingsFilled: 7,
      alreadyPresent: 0,
      needingAttention: 0,
    });
  });
});
