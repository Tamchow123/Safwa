import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendVerificationEmailMock = vi.fn();
vi.mock("@/modules/auth/client", () => ({
  sendVerificationEmail: (...args: unknown[]) =>
    sendVerificationEmailMock(...args),
}));

let currentSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

import { VerifyEmailStatus } from "@/components/auth/verify-email-status";

beforeEach(() => {
  sendVerificationEmailMock.mockReset();
  currentSearchParams = new URLSearchParams();
});

describe("VerifyEmailStatus", () => {
  it("shows a success state for Better Auth's success redirect, verified=1 (covers both just-verified and already-verified)", () => {
    currentSearchParams = new URLSearchParams({ verified: "1" });
    render(<VerifyEmailStatus />);
    expect(screen.getByTestId("verify-email-success")).toBeInTheDocument();
    expect(screen.getByText("Email verified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("never claims a verification on a direct visit with no query params (Phase 18.3)", () => {
    // Better Auth only ever redirects here with verified=1 or an error, so a
    // bare visit is a bookmark, a typed URL or a pre-18.3 link — evidence of
    // nothing. It gets a neutral state that offers a new link and sign-in.
    render(<VerifyEmailStatus />);
    expect(screen.getByTestId("verify-email-unconfirmed")).toBeInTheDocument();
    expect(
      screen.queryByTestId("verify-email-success"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Email verified")).not.toBeInTheDocument();
    expect(screen.getByText("Verify your email")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resend verification email" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/already verified\?/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it.each(["0", "true", "", "1x"])(
    "treats verified=%j as no evidence: only the exact marker means success",
    (value) => {
      currentSearchParams = new URLSearchParams({ verified: value });
      render(<VerifyEmailStatus />);
      expect(
        screen.getByTestId("verify-email-unconfirmed"),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ["TOKEN_EXPIRED", "verify-email-expired"],
    ["INVALID_TOKEN", "verify-email-invalid"],
    ["USER_NOT_FOUND", "verify-email-invalid"],
  ])(
    "lets error=%s win over the marker, since a failed link carries both",
    (code, testId) => {
      // The real failure redirect for a link sent with the marker callback:
      // Better Auth appends `&error=` to a callbackURL that has a query.
      currentSearchParams = new URLSearchParams(`verified=1&error=${code}`);
      render(<VerifyEmailStatus />);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      expect(
        screen.queryByTestId("verify-email-success"),
      ).not.toBeInTheDocument();
    },
  );

  it("shows an expired state for error=TOKEN_EXPIRED", () => {
    currentSearchParams = new URLSearchParams({ error: "TOKEN_EXPIRED" });
    render(<VerifyEmailStatus />);
    expect(screen.getByTestId("verify-email-expired")).toBeInTheDocument();
    expect(screen.getByText("This link has expired")).toBeInTheDocument();
  });

  it("shows an invalid state for error=INVALID_TOKEN", () => {
    currentSearchParams = new URLSearchParams({ error: "INVALID_TOKEN" });
    render(<VerifyEmailStatus />);
    expect(screen.getByTestId("verify-email-invalid")).toBeInTheDocument();
  });

  it("shows the same invalid state for any unrecognised error code, without revealing which reason applied", () => {
    currentSearchParams = new URLSearchParams({ error: "USER_NOT_FOUND" });
    render(<VerifyEmailStatus />);
    expect(screen.getByTestId("verify-email-invalid")).toBeInTheDocument();
    expect(screen.queryByText(/USER_NOT_FOUND/)).not.toBeInTheDocument();
  });

  it("never renders the raw token even if present in the query string", () => {
    currentSearchParams = new URLSearchParams({
      token: "super-secret-token-value",
    });
    render(<VerifyEmailStatus />);
    expect(
      screen.queryByText(/super-secret-token-value/),
    ).not.toBeInTheDocument();
  });

  it("offers a resend action on the expired/invalid states with a rate-limit-safe generic response", async () => {
    sendVerificationEmailMock.mockResolvedValue({ error: null, data: {} });
    currentSearchParams = new URLSearchParams({ error: "TOKEN_EXPIRED" });
    const user = userEvent.setup();
    render(<VerifyEmailStatus />);

    await user.type(screen.getByLabelText("Email"), "  Learner@Example.com ");
    await user.click(
      screen.getByRole("button", { name: "Resend verification email" }),
    );

    await waitFor(() =>
      expect(sendVerificationEmailMock).toHaveBeenCalledWith({
        email: "learner@example.com",
        callbackURL: "/verify-email?verified=1",
      }),
    );
    expect(
      screen.getByText(
        "If an account exists for that email and isn't verified yet, a new link is on its way.",
      ),
    ).toBeInTheDocument();
  });

  it("maps a 429 rate-limit response to a generic rate-limit message on resend", async () => {
    sendVerificationEmailMock.mockResolvedValue({
      error: { status: 429 },
      data: null,
    });
    currentSearchParams = new URLSearchParams({ error: "INVALID_TOKEN" });
    const user = userEvent.setup();
    render(<VerifyEmailStatus />);

    await user.type(screen.getByLabelText("Email"), "learner@example.com");
    await user.click(
      screen.getByRole("button", { name: "Resend verification email" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Too many attempts. Please wait a moment and try again.",
      ),
    );
  });

  it("offers a resend from the neutral state too", async () => {
    sendVerificationEmailMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<VerifyEmailStatus />);

    await user.type(screen.getByLabelText("Email"), "learner@example.com");
    await user.click(
      screen.getByRole("button", { name: "Resend verification email" }),
    );

    await waitFor(() =>
      expect(sendVerificationEmailMock).toHaveBeenCalledWith({
        email: "learner@example.com",
        callbackURL: "/verify-email?verified=1",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /a new link is on its way/,
    );
  });

  it("links to the login page from the expired/invalid state", () => {
    currentSearchParams = new URLSearchParams({ error: "TOKEN_EXPIRED" });
    render(<VerifyEmailStatus />);
    expect(
      screen.getByRole("link", { name: "Back to sign in" }),
    ).toHaveAttribute("href", "/login");
  });
});
