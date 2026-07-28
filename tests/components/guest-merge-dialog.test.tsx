import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestMergeContextValue } from "@/components/sync/guest-merge-provider";
import type {
  GuestMergeFlow,
  GuestMergeState,
} from "@/modules/sync/client/guest-merge-machine";
import type { GuestMergeSummaryView } from "@/modules/sync/client/guest-merge-summary";

/**
 * The dialog reads the merge through `useGuestMerge`, so the whole provider —
 * and with it Dexie, the auth session and the sync controller — is replaced by
 * a value here. What is under test is what the component DOES with a state, not
 * how the state is produced; the machine and runner have their own tests.
 */
const merge = vi.hoisted(() => ({ current: null as GuestMergeContextValue | null })); // prettier-ignore
vi.mock("@/components/sync/guest-merge-provider", () => ({
  useGuestMerge: () => merge.current,
}));

import { GuestMergeDialog } from "@/components/sync/guest-merge-dialog";

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

const COUNTS = {
  components: 4,
  events: 12,
  attempts: 12,
  bookmarks: 3,
  lists: 1,
};

const consent = vi.fn();
const defer = vi.fn();
const retry = vi.fn();
const dismiss = vi.fn();
const reconsider = vi.fn();

function mount(
  flow: GuestMergeFlow,
  overrides: Partial<GuestMergeContextValue> = {},
): void {
  const state: GuestMergeState = {
    session: { status: "signed-in", userId: "u1" },
    flow,
  };
  merge.current = {
    state,
    active: ["preparing", "uploading", "finalising", "rebasing"].includes(
      flow.name,
    ),
    canStart: ["ready-for-consent", "deferred", "retryable-error"].includes(
      flow.name,
    ),
    consent,
    defer,
    retry,
    dismiss,
    reconsider,
    visible: true,
    ...overrides,
  };
  render(<GuestMergeDialog />);
}

afterEach(() => {
  vi.clearAllMocks();
  merge.current = null;
});

describe("when the dialog says nothing", () => {
  it("renders nothing outside a provider", () => {
    merge.current = null;
    const { container } = render(<GuestMergeDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the session is still being checked", () => {
    mount({ name: "checking" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing when there is no guest data", () => {
    mount({ name: "no-guest-data" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing once a finished merge has been dismissed", () => {
    mount({ name: "completed", summary: SUMMARY }, { visible: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing once the learner has deferred (COMMIT-001)", () => {
    // The decline must CLOSE the prompt. An earlier version gave `deferred`
    // the same copy as `ready-for-consent`, so "Not now" left the identical
    // modal open with only its decline button removed — the refusal appeared
    // to do nothing, and the one remaining control was "Add to my account".
    mount({ name: "deferred", counts: COUNTS });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the consent prompt (§9.1, §19)", () => {
  it("shows the counts the learner is being asked about", () => {
    mount({ name: "ready-for-consent", counts: COUNTS });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Words studied");
    expect(dialog).toHaveTextContent("12");
    expect(dialog).toHaveTextContent("Bookmarks");
  });

  it("lists the counts as label/value pairs a screen reader can read", () => {
    // A description list, not a run-on line (§19 semantics). Asserting the
    // text alone would still pass if the markup became plain divs.
    mount({ name: "ready-for-consent", counts: COUNTS });
    const terms = screen.getAllByRole("term");
    const values = screen.getAllByRole("definition");
    expect(terms).toHaveLength(5);
    expect(values).toHaveLength(terms.length);
    expect(terms[0]).toHaveTextContent("Words studied");
  });

  it("offers Not now, and pressing it defers rather than merging", async () => {
    const user = userEvent.setup();
    mount({ name: "ready-for-consent", counts: COUNTS });
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(defer).toHaveBeenCalledTimes(1);
    expect(consent).not.toHaveBeenCalled();
  });

  it("sends nothing until the primary action is pressed", async () => {
    const user = userEvent.setup();
    mount({ name: "ready-for-consent", counts: COUNTS });
    expect(consent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add to my account" }));
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it("treats Escape as Not now, never as agreement", async () => {
    const user = userEvent.setup();
    mount({ name: "ready-for-consent", counts: COUNTS });
    await user.keyboard("{Escape}");
    expect(defer).toHaveBeenCalledTimes(1);
    expect(consent).not.toHaveBeenCalled();
  });

  it("is operable by keyboard alone (§19)", async () => {
    // Not merely "focus is somewhere in the dialog": the primary action must be
    // reachable by Tab and fire on Enter, which is what keyboard-only operation
    // actually means.
    const user = userEvent.setup();
    mount({ name: "ready-for-consent", counts: COUNTS });
    const add = screen.getByRole("button", { name: "Add to my account" });
    add.focus();
    expect(add).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(consent).toHaveBeenCalledTimes(1);
  });
});

describe("while the merge is running (§19)", () => {
  it("offers NO action at all, so there is nothing to press twice", () => {
    // §19 "disable duplicate submissions while active". The control is absent
    // rather than present-and-disabled, so this asserts the absence directly —
    // an earlier version looped over the buttons and asserted each was
    // disabled, which passed vacuously because there were none (REL-004).
    mount({ name: "uploading", progress: { chunksSent: 1, chunksTotal: 3, acceptedItems: 9 } }); // prettier-ignore
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("cannot be dismissed — closing would imply the merge stopped", async () => {
    const user = userEvent.setup();
    mount({ name: "finalising" });
    await user.keyboard("{Escape}");
    expect(defer).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("offers no Not now once anything has been sent", () => {
    mount({ name: "uploading", progress: { chunksSent: 1, chunksTotal: 2, acceptedItems: 5 } }); // prettier-ignore
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("announces progress politely", () => {
    mount({ name: "rebasing", attempt: 0, summary: SUMMARY, changedAnything: true }); // prettier-ignore
    const region = screen
      .getByRole("dialog")
      .querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("Restoring your history");
  });
});

describe("afterwards (§21)", () => {
  it("shows the summary and lets the learner close it", async () => {
    const user = userEvent.setup();
    mount({ name: "completed", summary: SUMMARY });
    expect(screen.getByRole("dialog")).toHaveTextContent("Reviews merged");
    await user.click(screen.getByRole("button", { name: "Continue studying" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not call a repeated merge a second success", () => {
    mount({ name: "completed-no-op", summary: { ...SUMMARY, kind: "no_op" } });
    expect(screen.getByRole("dialog")).toHaveTextContent("Nothing left to add");
  });

  it("offers a retry for a retryable failure, and calls retry not consent", async () => {
    const user = userEvent.setup();
    mount({ name: "retryable-error", reason: { kind: "rebase-failed" }, summary: SUMMARY }); // prettier-ignore
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(consent).not.toHaveBeenCalled();
  });

  it("offers NO retry where retrying cannot help", () => {
    mount({ name: "attention-required", reason: { kind: "session-changed" } });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("announces a stop assertively", () => {
    mount({ name: "attention-required", reason: { kind: "local" } });
    expect(
      screen.getByRole("dialog").querySelector('[aria-live="assertive"]'),
    ).not.toBeNull();
  });

  it("exposes no identifier, key or reason code in the rendered text", () => {
    // The copy module tests this exhaustively; this proves the component does
    // not add any of its own.
    mount({ name: "retryable-error", reason: { kind: "server", reasonCode: "snapshot_mismatch" } }); // prettier-ignore
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).not.toContain("snapshot_mismatch");
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });
});
