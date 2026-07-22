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

import { AccountMenu } from "@/components/auth/account-menu";

beforeEach(() => {
  signOutMock.mockReset();
  sessionState = { data: null, isPending: false, error: null };
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

  it("calls signOut when Sign out is activated", async () => {
    signOutMock.mockResolvedValue(undefined);
    sessionState = {
      data: { user: { email: "learner@example.com", id: "user-1" } },
      isPending: false,
      error: null,
    };
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
  });
});
