import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInEmailMock = vi.fn();
vi.mock("@/modules/auth/client", () => ({
  signIn: { email: (...args: unknown[]) => signInEmailMock(...args) },
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
