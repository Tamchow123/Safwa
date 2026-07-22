import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestPasswordResetMock = vi.fn();
const resetPasswordMock = vi.fn();
vi.mock("@/modules/auth/client", () => ({
  requestPasswordReset: (...args: unknown[]) =>
    requestPasswordResetMock(...args),
  resetPassword: (...args: unknown[]) => resetPasswordMock(...args),
}));

let currentSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

beforeEach(() => {
  requestPasswordResetMock.mockReset();
  resetPasswordMock.mockReset();
  currentSearchParams = new URLSearchParams();
});

describe("ForgotPasswordForm", () => {
  it("shows the same generic confirmation regardless of whether the email exists", async () => {
    requestPasswordResetMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText("Email"), "  Learner@Example.com ");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() =>
      expect(requestPasswordResetMock).toHaveBeenCalledWith({
        email: "learner@example.com",
        redirectTo: "/reset-password",
      }),
    );
    expect(screen.getByTestId("forgot-password-sent")).toBeInTheDocument();
    expect(
      screen.getByText(
        "If an account exists for that email, a password reset link is on its way.",
      ),
    ).toBeInTheDocument();
  });

  it("maps a 429 rate-limit response to a generic message", async () => {
    requestPasswordResetMock.mockResolvedValue({
      error: { status: 429 },
      data: null,
    });
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText("Email"), "learner@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Too many attempts. Please wait a moment and try again.",
      ),
    );
  });

  it("links back to sign in", () => {
    render(<ForgotPasswordForm />);
    expect(
      screen.getByRole("link", { name: "Back to sign in" }),
    ).toHaveAttribute("href", "/login");
  });
});

describe("ResetPasswordForm", () => {
  it("shows an invalid-link state with no token present, never reading a raw token", () => {
    currentSearchParams = new URLSearchParams();
    render(<ResetPasswordForm />);
    expect(screen.getByTestId("reset-password-invalid")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Request a new link" }),
    ).toHaveAttribute("href", "/forgot-password");
  });

  it("shows the same invalid-link state for error=INVALID_TOKEN even with a token present", () => {
    currentSearchParams = new URLSearchParams({
      token: "some-token",
      error: "INVALID_TOKEN",
    });
    render(<ResetPasswordForm />);
    expect(screen.getByTestId("reset-password-invalid")).toBeInTheDocument();
  });

  it("never renders the raw token value anywhere", () => {
    currentSearchParams = new URLSearchParams({
      token: "super-secret-token-value",
    });
    render(<ResetPasswordForm />);
    expect(
      screen.queryByText(/super-secret-token-value/),
    ).not.toBeInTheDocument();
  });

  it("shows an inline mismatch error and disables submit when passwords differ", async () => {
    currentSearchParams = new URLSearchParams({ token: "valid-token" });
    const user = userEvent.setup();
    render(<ResetPasswordForm />);

    await user.type(
      screen.getByLabelText("New password"),
      "correct-horse-battery",
    );
    await user.type(screen.getByLabelText("Confirm password"), "different");

    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update password" }),
    ).toBeDisabled();
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it("submits the token straight through to resetPassword and shows the revoked-sessions confirmation", async () => {
    currentSearchParams = new URLSearchParams({ token: "valid-token" });
    resetPasswordMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<ResetPasswordForm />);

    await user.type(
      screen.getByLabelText("New password"),
      "correct-horse-battery",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "correct-horse-battery",
    );
    await user.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() =>
      expect(resetPasswordMock).toHaveBeenCalledWith({
        newPassword: "correct-horse-battery",
        token: "valid-token",
      }),
    );
    expect(screen.getByTestId("reset-password-done")).toBeInTheDocument();
    expect(screen.getByText(/signed out everywhere else/)).toBeInTheDocument();
  });

  it("shows a learner-safe mapped error when resetPassword fails", async () => {
    currentSearchParams = new URLSearchParams({ token: "valid-token" });
    resetPasswordMock.mockResolvedValue({
      error: { code: "TOKEN_EXPIRED" },
      data: null,
    });
    const user = userEvent.setup();
    render(<ResetPasswordForm />);

    await user.type(
      screen.getByLabelText("New password"),
      "correct-horse-battery",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "correct-horse-battery",
    );
    await user.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This link has expired. Request a new one.",
      ),
    );
  });
});
