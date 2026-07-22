import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Proves guest independence at the unit level (phases-15.md §37): the rest
 * of the app must never wait on, or be blocked by, the auth service. The
 * full cross-feature proof (every existing learner feature usable under
 * AUTH_ENABLED=false and with an unreachable auth endpoint) is Playwright
 * E2E territory (T20); this suite proves the specific mechanism that makes
 * that possible — AccountMenu (the only Phase 15 addition to the shared
 * shell) never gates rendering on a session read, in either failure mode.
 */

const signOutMock = vi.fn();
let sessionState: {
  data: { user: { email: string } } | null;
  isPending: boolean;
  error: unknown;
};
vi.mock("@/modules/auth/client", () => ({
  useSession: () => sessionState,
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

import { AppHeader } from "@/components/app-header";

describe("guest independence", () => {
  it("renders the guest UI synchronously when auth is disabled (session read never resolves)", () => {
    sessionState = { data: null, isPending: true, error: null };
    render(<AppHeader />);

    // No render-blocking spinner/skeleton and no thrown error — the header
    // (and everything else in the shell) is interactive on the very first
    // render, before the session fetch has any chance to settle.
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument();
  });

  it("renders the guest UI when the auth endpoint is unreachable, without crashing the shell", () => {
    sessionState = {
      data: null,
      isPending: false,
      error: { message: "fetch failed" },
    };

    expect(() => render(<AppHeader />)).not.toThrow();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Create account" }),
    ).toBeInTheDocument();
  });

  it("never calls signOut or any other auth action for a guest render", () => {
    sessionState = { data: null, isPending: false, error: null };
    render(<AppHeader />);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("shows no mandatory auth modal or dialog for a guest", () => {
    sessionState = { data: null, isPending: false, error: null };
    render(<AppHeader />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
