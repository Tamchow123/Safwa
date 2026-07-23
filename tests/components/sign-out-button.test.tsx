import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the sign-out flow discharges SEC-002-T15d: after ending the server
 * session it wipes the previous account's synced local state (Dexie) AND the
 * non-Dexie UI-preference mirrors, so a shared device never leaks account A's
 * data to account B. The Dexie wipe itself is unit-tested in
 * modules/sync/client/logout.test.ts; this proves the button actually invokes
 * it (the wiring the security review flagged as the remaining gap).
 */
const signOutMock = vi.fn(async () => {});
vi.mock("@/modules/auth/client", () => ({ signOut: () => signOutMock() }));

const clearAccountLocalStateMock = vi.fn(async (db: unknown) => {
  void db;
});
vi.mock("@/modules/sync/client/logout", () => ({
  clearAccountLocalState: (db: unknown) => clearAccountLocalStateMock(db),
}));

const fakeDb = { name: "fake" };
vi.mock("@/modules/content/db", () => ({ getSafwaDb: () => fakeDb }));

import { SignOutButton } from "@/components/account/sign-out-button";

beforeEach(() => {
  signOutMock.mockClear();
  clearAccountLocalStateMock.mockClear();
  localStorage.setItem("theme", "dark");
  localStorage.setItem("safwa:settings:arabic-font-scale", "large");
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("SignOutButton", () => {
  it("signs out, then clears local account state + UI-preference mirrors", async () => {
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(clearAccountLocalStateMock).toHaveBeenCalled());
    expect(signOutMock).toHaveBeenCalledOnce();
    expect(clearAccountLocalStateMock).toHaveBeenCalledWith(fakeDb);
    // Server session is ended BEFORE the local wipe.
    expect(signOutMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearAccountLocalStateMock.mock.invocationCallOrder[0]!,
    );
    // The localStorage UI-preference mirrors are dropped.
    expect(localStorage.getItem("theme")).toBeNull();
    expect(localStorage.getItem("safwa:settings:arabic-font-scale")).toBeNull();
  });

  it("still signs out even if the local clear throws (best-effort)", async () => {
    clearAccountLocalStateMock.mockRejectedValueOnce(new Error("dexie down"));
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(signOutMock).toHaveBeenCalled());
    // The button recovers (not stuck pending) despite the clear failure.
    await waitFor(() => expect(screen.getByRole("button")).not.toBeDisabled());
  });
});
