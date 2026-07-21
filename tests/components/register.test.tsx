import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signUpEmailMock = vi.fn();
vi.mock("@/modules/auth/client", () => ({
  signUp: { email: (...args: unknown[]) => signUpEmailMock(...args) },
}));

import { RegisterForm } from "@/components/auth/register-form";

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "Amina Yusuf");
  await user.type(screen.getByLabelText("Email"), "  Amina@Example.com  ");
  await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
  await user.type(
    screen.getByLabelText("Confirm password"),
    "correct-horse-battery",
  );
}

beforeEach(() => {
  signUpEmailMock.mockReset();
});

describe("RegisterForm", () => {
  it("renders every required field with an accessible label and password autocomplete attrs", () => {
    render(<RegisterForm />);
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "autocomplete",
      "name",
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "autocomplete",
      "email",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByText(/8-128 characters/)).toBeInTheDocument();
  });

  it("disables submit until the form is validly filled", async () => {
    const user = userEvent.setup();
    render(<RegisterForm />);
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeDisabled();
    await fillValidForm(user);
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
  });

  it("shows an inline mismatch error and disables submit when passwords differ", async () => {
    const user = userEvent.setup();
    render(<RegisterForm />);
    await user.type(screen.getByLabelText("Name"), "Amina Yusuf");
    await user.type(screen.getByLabelText("Email"), "amina@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeDisabled();
    expect(signUpEmailMock).not.toHaveBeenCalled();
  });

  it("normalises the email (trim + lowercase) and sets callbackURL to /verify-email on submit", async () => {
    signUpEmailMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<RegisterForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUpEmailMock).toHaveBeenCalledTimes(1));
    expect(signUpEmailMock).toHaveBeenCalledWith({
      name: "Amina Yusuf",
      email: "amina@example.com",
      password: "correct-horse-battery",
      callbackURL: "/verify-email",
    });
  });

  it("shows an honest verification-required state after a successful submission — never claims the account is usable yet", async () => {
    signUpEmailMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<RegisterForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(
        screen.getByTestId("register-verification-notice"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/amina@example\.com/)).toBeInTheDocument();
    expect(screen.getByText("Check your email")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();
  });

  it("shows a learner-safe mapped error message when signUp fails", async () => {
    signUpEmailMock.mockResolvedValue({
      error: { code: "PASSWORD_TOO_SHORT" },
      data: null,
    });
    const user = userEvent.setup();
    render(<RegisterForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Choose a longer password.",
      ),
    );
    expect(
      screen.queryByTestId("register-verification-notice"),
    ).not.toBeInTheDocument();
  });

  it("shows the pending state and disables the submit button while submitting", async () => {
    let resolveSignUp: (value: { error: null; data: object }) => void;
    signUpEmailMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSignUp = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<RegisterForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      screen.getByRole("button", { name: "Creating account…" }),
    ).toBeDisabled();

    resolveSignUp!({ error: null, data: {} });
    await waitFor(() =>
      expect(
        screen.getByTestId("register-verification-notice"),
      ).toBeInTheDocument(),
    );
  });

  it("links to the login page", () => {
    render(<RegisterForm />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("never renders a role selector or a guest-data-upload prompt", () => {
    render(<RegisterForm />);
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/merge/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/upload/i)).not.toBeInTheDocument();
  });
});
