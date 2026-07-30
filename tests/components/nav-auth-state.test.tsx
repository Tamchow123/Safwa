import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signOutMock = vi.fn();
let sessionState: {
  data: { user: { email: string; id: string } } | null;
  isPending: boolean;
  error: unknown;
};
vi.mock("@/modules/auth/client", () => ({
  useSession: () => sessionState,
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

// The global header sign-out MUST go through the single shared wipe helper so
// this path also clears the previous account's local state on a shared device
// (SEC-002-T15d) — not just the /account page button.
const signOutAndClearMock = vi.fn(async () => {});
vi.mock("@/components/account/sign-out-action", () => ({
  signOutAndClearLocalState: () => signOutAndClearMock(),
}));

import { AccountMenu } from "@/components/auth/account-menu";
import { LAST_KNOWN_OWNER_STORAGE_KEY } from "@/modules/auth/last-known-owner";

beforeEach(() => {
  signOutMock.mockReset();
  signOutAndClearMock.mockClear();
  sessionState = { data: null, isPending: false, error: null };
  localStorage.clear();
});

describe("AccountMenu", () => {
  it("shows sign-in/create-account links for a guest", () => {
    render(<AccountMenu />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(
      screen.getByRole("link", { name: "Create account" }),
    ).toHaveAttribute("href", "/register");
  });

  it("shows the guest links while the session read is still pending, never a blocking loader", () => {
    sessionState = { data: null, isPending: true, error: null };
    render(<AccountMenu />);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("falls back to the guest links when the session read errored (auth disabled or unreachable)", () => {
    sessionState = {
      data: null,
      isPending: false,
      error: { message: "network error" },
    };
    render(<AccountMenu />);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("says Offline — not 'Sign in' — when the read errored and this device remembers an owner", async () => {
    // Phase 18 §5. An offline cold boot IS an errored session read. Showing a
    // signed-in learner "Sign in / Create account" invites them to do the one
    // thing that cannot work, and implies their account is gone.
    localStorage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, "user-1");
    sessionState = { data: null, isPending: false, error: { status: 0 } };

    render(<AccountMenu />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Offline"),
    );
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });

  it("still shows the guest links when the read errored and nothing is remembered", () => {
    // A first-time visitor on a broken network is, as far as anyone knows, a
    // guest — so the Phase 15 behaviour is unchanged for them.
    sessionState = { data: null, isPending: false, error: { status: 0 } };

    render(<AccountMenu />);

    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not say Offline merely because the session is still pending", () => {
    // `isPending` also classifies as `unknown`, but a first read in flight is
    // not evidence of a lost network, and the guest links must never block on
    // it (the Phase 15 rule this component was built around).
    localStorage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, "user-1");
    sessionState = { data: null, isPending: true, error: null };

    render(<AccountMenu />);

    // Without this distinction every ordinary cold start would flash "Offline"
    // at a signed-in learner before their session resolved.
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the account menu with the email (never a raw user id) when signed in", async () => {
    sessionState = {
      data: { user: { email: "learner@example.com", id: "user-internal-id" } },
      isPending: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<AccountMenu />);

    expect(
      screen.queryByRole("link", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Account menu" }));

    expect(screen.getByText("learner@example.com")).toBeInTheDocument();
    expect(screen.queryByText("user-internal-id")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Account" })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(
      screen.getByRole("menuitem", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("supports keyboard navigation into the menu", async () => {
    sessionState = {
      data: { user: { email: "learner@example.com", id: "user-1" } },
      isPending: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<AccountMenu />);

    const trigger = screen.getByRole("button", { name: "Account menu" });
    trigger.focus();
    await user.keyboard("{Enter}");

    expect(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("signs out via the shared wipe helper so the header path also clears local state", async () => {
    sessionState = {
      data: { user: { email: "learner@example.com", id: "user-1" } },
      isPending: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    // The global header sign-out routes through signOutAndClearLocalState (which
    // ends the session AND wipes local account state), never bare signOut().
    await waitFor(() => expect(signOutAndClearMock).toHaveBeenCalledTimes(1));
  });
});
