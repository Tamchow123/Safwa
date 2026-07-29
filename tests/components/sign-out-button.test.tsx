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
const SIGNED_IN_USER_ID = "user-1";
vi.mock("@/modules/auth/client", () => ({
  signOut: () => signOutMock(),
  // The button renders on a signed-in page, so it holds the departing id and
  // passes it into the cleanup rather than making it re-read the session
  // (phases-17.md §11).
  useSession: () => ({ data: { user: { id: SIGNED_IN_USER_ID } } }),
}));

const clearAccountLocalStateMock = vi.fn(
  async (db: unknown, departing: unknown) => {
    void db;
    void departing;
  },
);
vi.mock("@/modules/sync/client/logout", () => ({
  clearAccountLocalState: (db: unknown, departing: unknown) =>
    clearAccountLocalStateMock(db, departing),
}));

const fakeDb = { name: "fake" };
vi.mock("@/modules/content/db", () => ({ getSafwaDb: () => fakeDb }));

import { SignOutButton } from "@/components/account/sign-out-button";
import { LAST_KNOWN_OWNER_STORAGE_KEY } from "@/modules/auth/last-known-owner";

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
    // Scoped to the DEPARTING account (§11): the cleanup removes that
    // account's rows and leaves a coexisting guest's rows intact.
    expect(clearAccountLocalStateMock).toHaveBeenCalledWith(
      fakeDb,
      SIGNED_IN_USER_ID,
    );
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

  it("forgets the durable last-known owner (Phase 18 §2.1)", async () => {
    // Not a cosmetic mirror like theme/font-scale: this is what an offline
    // cold boot resolves an unclassifiable session to, so leaving it behind
    // would let the NEXT person on this device write rows stamped with the
    // departing account's owner key.
    localStorage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, SIGNED_IN_USER_ID);

    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() =>
      expect(localStorage.getItem(LAST_KNOWN_OWNER_STORAGE_KEY)).toBeNull(),
    );
  });

  it("forgets it even when the Dexie sweep fails", async () => {
    // The two are independent: a stale owner is wrong whether or not the
    // account's rows were removed, and the forget runs BEFORE the sweep.
    clearAccountLocalStateMock.mockRejectedValueOnce(new Error("dexie down"));
    localStorage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, SIGNED_IN_USER_ID);

    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() =>
      expect(localStorage.getItem(LAST_KNOWN_OWNER_STORAGE_KEY)).toBeNull(),
    );
  });
});
