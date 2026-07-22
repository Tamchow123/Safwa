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
  it("shows a success state when there is no error query param (covers both just-verified and already-verified)", () => {
    render(<VerifyEmailStatus />);
    expect(screen.getByTestId("verify-email-success")).toBeInTheDocument();
    expect(screen.getByText("Email verified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

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
        callbackURL: "/verify-email",
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

  it("links to the login page from the expired/invalid state", () => {
    currentSearchParams = new URLSearchParams({ error: "TOKEN_EXPIRED" });
    render(<VerifyEmailStatus />);
    expect(
      screen.getByRole("link", { name: "Back to sign in" }),
    ).toHaveAttribute("href", "/login");
  });
});
