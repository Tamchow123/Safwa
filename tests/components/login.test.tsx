import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInEmailMock = vi.fn();
const sendVerificationEmailMock = vi.fn();
vi.mock("@/modules/auth/client", () => ({
  signIn: { email: (...args: unknown[]) => signInEmailMock(...args) },
  sendVerificationEmail: (...args: unknown[]) =>
    sendVerificationEmailMock(...args),
}));

const routerPush = vi.fn();
let currentSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => currentSearchParams,
}));

import { LoginForm } from "@/components/auth/login-form";

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "  Amina@Example.com  ");
  await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
}

beforeEach(() => {
  signInEmailMock.mockReset();
  sendVerificationEmailMock.mockReset();
  routerPush.mockReset();
  currentSearchParams = new URLSearchParams();
});

describe("LoginForm", () => {
  it("renders accessible fields with autocomplete attrs and defaults remember-me on", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "autocomplete",
      "email",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByRole("checkbox", { name: "Remember me" })).toBeChecked();
  });

  it("disables submit until email and password are entered", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    await fillValidForm(user);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("normalises the email and passes rememberMe on submit", async () => {
    signInEmailMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<LoginForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(signInEmailMock).toHaveBeenCalledTimes(1));
    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "amina@example.com",
      password: "correct-horse-battery",
      rememberMe: true,
    });
  });

  it("redirects to a validated safe path from ?next= on success", async () => {
    currentSearchParams = new URLSearchParams({ next: "/study" });
    signInEmailMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<LoginForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/study"));
  });

  it("falls back to the safe default when ?next= is an external URL", async () => {
    currentSearchParams = new URLSearchParams({
      next: "https://evil.example.com",
    });
    signInEmailMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<LoginForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/"));
  });

  it("shows the same generic message for unknown email and wrong password", async () => {
    signInEmailMock.mockResolvedValue({
      error: { code: "INVALID_EMAIL_OR_PASSWORD" },
      data: null,
    });
    const user = userEvent.setup();
    render(<LoginForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Incorrect email or password.",
      ),
    );
  });

  it("shows the pending state and disables submit while signing in", async () => {
    let resolveSignIn: (value: { error: null; data: object }) => void;
    signInEmailMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();

    resolveSignIn!({ error: null, data: {} });
    await waitFor(() => expect(routerPush).toHaveBeenCalled());
  });

  describe("resend for an unverified account (Phase 18.3)", () => {
    const NOT_VERIFIED = {
      error: { status: 403, code: "EMAIL_NOT_VERIFIED" },
      data: null,
    };

    function resendButton() {
      return screen.queryByRole("button", {
        name: "Resend verification email",
      });
    }

    it("offers a resend after EMAIL_NOT_VERIFIED, sent to the address that was refused", async () => {
      signInEmailMock.mockResolvedValue(NOT_VERIFIED);
      sendVerificationEmailMock.mockResolvedValue({ error: null, data: {} });
      const user = userEvent.setup();
      render(<LoginForm />);
      await fillValidForm(user);
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Verify your email address before signing in.",
      );
      // Edited after the refusal: the resend still goes to the refused address.
      await user.clear(screen.getByLabelText("Email"));
      await user.type(screen.getByLabelText("Email"), "someone@else.test");
      await user.click(resendButton()!);

      await waitFor(() =>
        expect(sendVerificationEmailMock).toHaveBeenCalledWith({
          email: "amina@example.com",
          callbackURL: "/verify-email?verified=1",
        }),
      );
      expect(await screen.findByRole("status")).toHaveTextContent(
        "If an account exists for that email and isn't verified yet, a new link is on its way.",
      );
      // A learner whose email still has not arrived can ask again.
      expect(resendButton()).toBeEnabled();
    });

    it.each([
      ["wrong credentials", { error: { code: "INVALID_EMAIL_OR_PASSWORD" } }],
      ["a rate-limited sign-in", { error: { status: 429 } }],
      ["an unrecognised failure", { error: { code: "SOMETHING_ELSE" } }],
    ])("offers no resend after %s", async (_label, result) => {
      signInEmailMock.mockResolvedValue({ ...result, data: null });
      const user = userEvent.setup();
      render(<LoginForm />);
      await fillValidForm(user);
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      await screen.findByRole("alert");
      expect(resendButton()).not.toBeInTheDocument();
      expect(sendVerificationEmailMock).not.toHaveBeenCalled();
    });

    it("offers no resend when sign-in throws", async () => {
      signInEmailMock.mockRejectedValue(new Error("network down"));
      const user = userEvent.setup();
      render(<LoginForm />);
      await fillValidForm(user);
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      await screen.findByRole("alert");
      expect(resendButton()).not.toBeInTheDocument();
    });

    it("maps a 429 on resend to the rate-limit message", async () => {
      signInEmailMock.mockResolvedValue(NOT_VERIFIED);
      sendVerificationEmailMock.mockResolvedValue({
        error: { status: 429 },
        data: null,
      });
      const user = userEvent.setup();
      render(<LoginForm />);
      await fillValidForm(user);
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      await user.click(
        await screen.findByRole("button", {
          name: "Resend verification email",
        }),
      );

      const offer = screen.getByTestId("login-resend-verification");
      await waitFor(() =>
        expect(within(offer).getByRole("alert")).toHaveTextContent(
          "Too many attempts. Please wait a moment and try again.",
        ),
      );
      expect(within(offer).queryByRole("status")).not.toBeInTheDocument();
    });

    it("starts afresh on the next sign-in attempt, and goes away when it is not needed", async () => {
      signInEmailMock.mockResolvedValue(NOT_VERIFIED);
      sendVerificationEmailMock.mockResolvedValue({ error: null, data: {} });
      const user = userEvent.setup();
      render(<LoginForm />);
      await fillValidForm(user);
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      await user.click(
        await screen.findByRole("button", {
          name: "Resend verification email",
        }),
      );
      expect(await screen.findByRole("status")).toBeInTheDocument();

      // Refused again: the offer is back, without the previous "sent" note.
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() =>
        expect(screen.queryByRole("status")).not.toBeInTheDocument(),
      );
      expect(resendButton()).toBeInTheDocument();

      // A different failure: no offer at all.
      signInEmailMock.mockResolvedValue({
        error: { code: "INVALID_EMAIL_OR_PASSWORD" },
        data: null,
      });
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() => expect(resendButton()).not.toBeInTheDocument());
    });
  });

  it("links to register and forgot-password", () => {
    render(<LoginForm />);
    expect(screen.getByRole("link", { name: "Create one" })).toHaveAttribute(
      "href",
      "/register",
    );
    expect(
      screen.getByRole("link", { name: "Forgot password?" }),
    ).toHaveAttribute("href", "/forgot-password");
  });
});
