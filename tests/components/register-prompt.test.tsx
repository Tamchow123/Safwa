import "fake-indexeddb/auto";

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterPrompt } from "@/components/register-prompt";
import type { ClassifiableSession } from "@/modules/auth/session-identity";
import { getSafwaDb } from "@/modules/content/db";
import { getOrCreateDeviceProfile } from "@/modules/profile/device";
import {
  isRegisterPromptDismissed,
  SETTING_KEYS,
  writeGuestSetting,
  writeSetting,
} from "@/modules/profile/settings";

const GUEST_SESSION: ClassifiableSession = {
  data: null,
  isPending: false,
  error: null,
};

// The session each render sees. tests/setup.ts mocks every session as a guest;
// this file needs to vary it, so it overrides that mock with a mutable one.
const session = vi.hoisted(() => ({
  current: { data: null, isPending: false, error: null } as ClassifiableSession,
}));

vi.mock("@/modules/auth/client", async (importActual) => {
  const actual = await importActual<typeof import("@/modules/auth/client")>();
  return { ...actual, useSession: () => session.current };
});

// The component reads through the real browser singleton, so tests seed and
// clear that same database.
const db = getSafwaDb();

beforeEach(async () => {
  session.current = GUEST_SESSION;
  // An account session is remembered as this device's last-known owner.
  localStorage.clear();
  await db.profile.clear();
  await db.settings.clear();
});

afterAll(async () => {
  await db.delete();
});

/**
 * Flush the component's async Dexie read. IndexedDB requests resolve on
 * macrotasks, so a plain microtask tick is not enough.
 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe("RegisterPrompt", () => {
  it("stays hidden while no guest state exists (lazy profile not minted)", async () => {
    render(<RegisterPrompt />);
    await flush();
    expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();
  });

  it("appears once a device profile exists and is not dismissed", async () => {
    await getOrCreateDeviceProfile(db);
    render(<RegisterPrompt />);
    expect(await screen.findByTestId("register-prompt")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /export my data in settings/i }),
    ).toHaveAttribute("href", "/settings");
  });

  it("stays hidden when previously dismissed", async () => {
    await getOrCreateDeviceProfile(db);
    await writeSetting(db, SETTING_KEYS.registerPromptDismissed, true);
    render(<RegisterPrompt />);
    await flush();
    expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();
  });

  it("dismisses durably via the settings store", async () => {
    await getOrCreateDeviceProfile(db);
    render(<RegisterPrompt />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(await isRegisterPromptDismissed(db, null)).toBe(true);
    });
  });

  it("appears in place when first progress happens while it is mounted", async () => {
    // The Codex-reported path: the guest is on the dashboard (prompt
    // mounted, hidden — no profile yet) and makes their first durable
    // action elsewhere in the shell, e.g. the header theme toggle. The
    // prompt must surface without a navigation or reload.
    render(<RegisterPrompt />);
    await flush();
    expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();

    await act(async () => {
      await writeGuestSetting(db, SETTING_KEYS.theme, "dark", {
        persist: async () => true,
      });
    });

    expect(await screen.findByTestId("register-prompt")).toBeInTheDocument();
  });

  it("does not reappear when its own dismissal fires the guest-state event", async () => {
    // dismissRegisterPrompt is itself a guest write, so it announces
    // guest-state-changed BEFORE the dismissed flag is readable back; the
    // re-check must not race the prompt back onto the screen.
    await getOrCreateDeviceProfile(db);
    render(<RegisterPrompt />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /dismiss/i }));
    await flush();
    expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();
  });

  describe("only for a guest (Phase 18.3)", () => {
    // Every case below has guest history on the device and no dismissal — the
    // exact state that showed a signed-in learner the guest note.
    it.each<[string, ClassifiableSession]>([
      [
        "a signed-in account",
        { data: { user: { id: "acct-1" } }, isPending: false, error: null },
      ],
      [
        "an account whose session refresh failed offline",
        {
          data: { user: { id: "acct-1" } },
          isPending: false,
          error: { status: 0 },
        },
      ],
      ["a session still loading", { data: null, isPending: true, error: null }],
      [
        "a session the server could not answer (offline or auth disabled)",
        { data: null, isPending: false, error: { status: 503 } },
      ],
    ])("stays hidden for %s", async (_label, current) => {
      await getOrCreateDeviceProfile(db);
      session.current = current;
      render(<RegisterPrompt />);
      await flush();
      expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();
    });

    it("still shows for a guest whose session expired (401)", async () => {
      await getOrCreateDeviceProfile(db);
      session.current = {
        data: null,
        isPending: false,
        error: { status: 401 },
      };
      render(<RegisterPrompt />);
      expect(await screen.findByTestId("register-prompt")).toBeInTheDocument();
    });

    it("never flashes while the session loads, and appears once it resolves to a guest", async () => {
      await getOrCreateDeviceProfile(db);
      session.current = { data: null, isPending: true, error: null };
      const { rerender } = render(<RegisterPrompt />);
      await flush();
      expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();

      session.current = GUEST_SESSION;
      rerender(<RegisterPrompt />);
      expect(await screen.findByTestId("register-prompt")).toBeInTheDocument();
    });

    it("disappears when a guest signs in while it is showing", async () => {
      await getOrCreateDeviceProfile(db);
      const { rerender } = render(<RegisterPrompt />);
      expect(await screen.findByTestId("register-prompt")).toBeInTheDocument();

      session.current = {
        data: { user: { id: "acct-1" } },
        isPending: false,
        error: null,
      };
      rerender(<RegisterPrompt />);
      await flush();
      expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();
    });

    it("stays hidden for an account when guest progress happens while it is mounted", async () => {
      session.current = {
        data: { user: { id: "acct-1" } },
        isPending: false,
        error: null,
      };
      render(<RegisterPrompt />);
      await flush();

      await act(async () => {
        await writeGuestSetting(db, SETTING_KEYS.theme, "dark", {
          persist: async () => true,
        });
      });
      await flush();
      expect(screen.queryByTestId("register-prompt")).not.toBeInTheDocument();
    });
  });
});
