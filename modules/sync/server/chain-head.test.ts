import { describe, expect, it } from "vitest";

import {
  countChainRoots,
  isLaterHead,
  selectHead,
  type HeadCandidate,
} from "./chain-head";

function ev(
  eventId: string,
  canonicalMs: number,
  clientComponentRevision: number,
  parentEventId: string | null = null,
): HeadCandidate {
  return { eventId, canonicalMs, clientComponentRevision, parentEventId };
}

/** An ordinary chain: one root, contiguous revisions, each parented on the last. */
function strictChain(
  prefix: string,
  times: readonly number[],
): HeadCandidate[] {
  return times.map((ms, index) =>
    ev(
      `${prefix}${index + 1}`,
      ms,
      index + 1,
      index === 0 ? null : `${prefix}${index}`,
    ),
  );
}

describe("countChainRoots", () => {
  it("counts one root for an ordinary chain", () => {
    expect(countChainRoots(strictChain("a", [1_000, 2_000, 3_000]))).toBe(1);
  });

  it("counts two roots for a merged union", () => {
    expect(
      countChainRoots([
        ...strictChain("g", [1_000, 2_000]),
        ...strictChain("a", [9_000]),
      ]),
    ).toBe(2);
  });

  it("treats an event whose parent is not accepted as its own root", () => {
    // An imported history hangs from an anchor the account never accepted.
    expect(countChainRoots([ev("x", 1_000, 4, "not-accepted")])).toBe(1);
  });
});

describe("selectHead — ordinary single-rooted chain", () => {
  it("is null for a component with no accepted events", () => {
    expect(selectHead([])).toBeNull();
  });

  it("picks the structural tip, independent of row order", () => {
    const chain = strictChain("a", [1_000, 2_000, 3_000]);
    expect(selectHead(chain)?.eventId).toBe("a3");
    expect(selectHead([...chain].reverse())?.eventId).toBe("a3");
  });

  it("STILL picks the structural tip when canonical times are not monotonic", () => {
    // The regression this guards (REL-003). A child held as `pending_parent` is
    // stamped with a canonical time while still pending and keeps it when
    // promoted, so after an out-of-order delivery the true tip can carry an
    // EARLIER time than its own parent — ordinary clock drift is enough.
    //
    // A chronological rule would name a2 the head. The client parents its next
    // event on a3, the server would reject it as a stale branch, and because the
    // stored times never change on retry the component would be stuck for good.
    // Revisions are structural, so they are what an ordinary chain is judged by.
    const chain = [
      ev("a1", 1_000, 1, null),
      ev("a2", 9_000, 2, "a1"), // accepted later, with a fast clock
      ev("a3", 5_000, 3, "a2"), // held pending, promoted after, earlier stamp
    ];
    expect(selectHead(chain)?.eventId).toBe("a3");
  });
});

describe("selectHead — merged union", () => {
  it("picks the CHRONOLOGICAL head, not the longer chain's tip", () => {
    // A guest studied five times long ago; the account twice, more recently.
    // Both chains number revisions from 1, so "highest revision" is the guest's
    // fifth event — not the last thing the learner did.
    const guest = strictChain("g", [1_000, 2_000, 3_000, 4_000, 5_000]);
    const account = strictChain("a", [9_000, 10_000]);

    expect(selectHead([...guest, ...account])?.eventId).toBe("a2");
    expect(selectHead([...account, ...guest])?.eventId).toBe("a2");
  });

  it("picks the guest's tail when the guest studied last", () => {
    // Not biased toward either identity, only toward time.
    const account = strictChain("a", [1_000, 2_000]);
    const guest = strictChain("g", [8_000]);
    expect(selectHead([...account, ...guest])?.eventId).toBe("g1");
  });

  it("breaks an instant tie by revision, then by event id", () => {
    expect(selectHead([ev("a", 5_000, 1), ev("b", 5_000, 2)])?.eventId).toBe(
      "b",
    );
    expect(selectHead([ev("b", 5_000, 1), ev("a", 5_000, 1)])?.eventId).toBe(
      "b",
    );
  });

  it("is a total order — every permutation yields the same head", () => {
    const events = [ev("x", 5_000, 2), ev("y", 5_000, 2), ev("z", 4_000, 9)];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const heads = permutations.map(
      (order) => selectHead(order.map((i) => events[i]))?.eventId,
    );
    expect(new Set(heads).size).toBe(1);
    expect(heads[0]).toBe("y");
  });
});

describe("isLaterHead", () => {
  it("accepts any candidate when there is no head yet", () => {
    expect(isLaterHead(ev("a", 0, 0), null)).toBe(true);
  });

  it("refuses an event that is not later than the head", () => {
    const head = ev("b", 5_000, 3);
    expect(isLaterHead(ev("a", 4_000, 9), head)).toBe(false);
    expect(isLaterHead(ev("a", 5_000, 2), head)).toBe(false);
    expect(isLaterHead(ev("a", 5_000, 3), head)).toBe(false);
    expect(isLaterHead(head, head)).toBe(false);
  });
});
