import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestMergeContextValue } from "@/components/sync/guest-merge-provider";
import type {
  GuestMergeFlow,
  GuestMergeState,
} from "@/modules/sync/client/guest-merge-machine";

/**
 * The deferred merge entry point in the data-settings card (§19 "expose the
 * deferred action later"). The provider is replaced, so what is under test is
 * which control the card offers for which flow — not how the flow is produced.
 */
const merge = vi.hoisted(() => ({ current: null as GuestMergeContextValue | null })); // prettier-ignore
vi.mock("@/components/sync/guest-merge-provider", () => ({
  useGuestMerge: () => merge.current,
}));
vi.mock("@/components/sync/use-local-owner", () => ({
  useResolveOwner: () => async () => Promise.resolve(null),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { DataSettings } from "@/components/settings/data-settings";

const COUNTS = {
  components: 4,
  events: 12,
  attempts: 12,
  bookmarks: 3,
  lists: 1,
};

const consent = vi.fn();
const reconsider = vi.fn();
const retry = vi.fn();

function mount(flow: GuestMergeFlow, signedIn = true): void {
  const state: GuestMergeState = {
    session: signedIn ? { status: "signed-in", userId: "u1" } : { status: "signed-out" }, // prettier-ignore
    flow,
  };
  merge.current = {
    state,
    active: false,
    canStart: true,
    consent,
    defer: vi.fn(),
    retry,
    dismiss: vi.fn(),
    reconsider,
    visible: true,
  };
  render(<DataSettings />);
}

afterEach(() => {
  vi.clearAllMocks();
  merge.current = null;
});

describe("the deferred merge entry point (§19)", () => {
  it("offers to re-open the prompt after Not now — and does not consent (SEC-002)", async () => {
    // The button must show the counts again, not start an upload from a control
    // whose only information was its own label.
    const user = userEvent.setup();
    mount({ name: "deferred", counts: COUNTS });
    await user.click(screen.getByTestId("merge-guest-data"));
    expect(reconsider).toHaveBeenCalledTimes(1);
    expect(consent).not.toHaveBeenCalled();
  });

  it("offers a retry after a dismissed retryable failure (REL-006)", async () => {
    // A learner who closes the failure notice must still have a way back. An
    // earlier version gated this entry point on `deferred` alone, which left a
    // dismissed retryable error with no control anywhere in the app that could
    // resume it — the guest data was stuck until a sign-out and back in.
    const user = userEvent.setup();
    mount({ name: "retryable-error", reason: { kind: "transport", failure: "network" } }); // prettier-ignore
    await user.click(screen.getByTestId("retry-guest-merge"));
    expect(retry).toHaveBeenCalledTimes(1);
    // A retry is not a fresh consent: the learner already agreed.
    expect(consent).not.toHaveBeenCalled();
    expect(reconsider).not.toHaveBeenCalled();
  });

  it("offers nothing while a merge is running or finished", () => {
    for (const flow of [
      { name: "preparing" } as const,
      { name: "no-guest-data" } as const,
      { name: "checking" } as const,
    ]) {
      mount(flow);
      expect(screen.queryByTestId("merge-guest-data")).toBeNull();
      expect(screen.queryByTestId("retry-guest-merge")).toBeNull();
    }
  });

  it("does not tell a signed-in learner they are a guest (REL-005)", () => {
    mount({ name: "deferred", counts: COUNTS });
    expect(screen.queryByText(/As a guest/)).toBeNull();
    expect(screen.getByText(/syncs to your account/)).toBeInTheDocument();
  });

  it("still warns a genuine guest that this browser is the only copy", () => {
    mount({ name: "no-guest-data" }, false);
    expect(screen.getByText(/As a guest/)).toBeInTheDocument();
  });
});
