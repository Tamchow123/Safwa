import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const changePasswordMock = vi.fn();
const signOutMock = vi.fn();
vi.mock("@/modules/auth/client", () => ({
  changePassword: (...args: unknown[]) => changePasswordMock(...args),
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

const toastMock = vi.fn();
vi.mock("sonner", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

import { AccountSettingsForm } from "@/components/account/account-settings-form";
import { ChangePasswordDialog } from "@/components/account/change-password-dialog";
import { SignOutButton } from "@/components/account/sign-out-button";

const SETTINGS = {
  theme: "system",
  arabicFontScale: "default",
  timezone: { mode: "browser" },
  sessionDefaults: {
    questionCount: 20,
    optionCount: 4,
    newPerDay: 10,
    reviewsPerDay: 20,
  },
};

beforeEach(() => {
  changePasswordMock.mockReset();
  signOutMock.mockReset();
  toastMock.mockReset();
});

describe("ChangePasswordDialog", () => {
  it("disables submit until current + valid matching new passwords are entered", async () => {
    const user = userEvent.setup();
    render(<ChangePasswordDialog />);
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(
      screen.getByRole("button", { name: "Update password" }),
    ).toBeDisabled();

    await user.type(screen.getByLabelText("Current password"), "current-pass");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "new-password-1",
    );

    expect(
      screen.getByRole("button", { name: "Update password" }),
    ).toBeEnabled();
  });

  it("calls changePassword with revokeOtherSessions and shows a success toast", async () => {
    changePasswordMock.mockResolvedValue({ error: null, data: {} });
    const user = userEvent.setup();
    render(<ChangePasswordDialog />);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText("Current password"), "current-pass");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "new-password-1",
    );
    await user.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() =>
      expect(changePasswordMock).toHaveBeenCalledWith({
        currentPassword: "current-pass",
        newPassword: "new-password-1",
        revokeOtherSessions: true,
      }),
    );
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
  });

  it("shows a learner-safe error when changePassword fails", async () => {
    changePasswordMock.mockResolvedValue({
      error: { code: "INVALID_PASSWORD" },
      data: null,
    });
    const user = userEvent.setup();
    render(<ChangePasswordDialog />);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText("Current password"), "wrong");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "new-password-1",
    );
    await user.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Incorrect email or password.",
      ),
    );
  });
});

describe("SignOutButton", () => {
  it("calls signOut and disables itself while pending", async () => {
    let resolveSignOut: () => void;
    signOutMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSignOut = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<SignOutButton />);

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();

    resolveSignOut!();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled(),
    );
  });
});

describe("AccountSettingsForm", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("loads settings on mount and renders the fetched theme as selected", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: SETTINGS }),
    }) as unknown as typeof fetch;

    render(<AccountSettingsForm />);

    expect(
      await screen.findByTestId("account-settings-form"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows a load error when the fetch fails, without crashing", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    render(<AccountSettingsForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load your account settings",
    );
  });

  it("saves via PUT with the current in-memory settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: SETTINGS }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<AccountSettingsForm />);
    await screen.findByTestId("account-settings-form");

    await user.click(
      screen.getByRole("button", { name: "Save account settings" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/account/settings",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
  });

  it("resets via DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: SETTINGS }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<AccountSettingsForm />);
    await screen.findByTestId("account-settings-form");

    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/account/settings",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
