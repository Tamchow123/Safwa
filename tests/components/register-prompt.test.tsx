import "fake-indexeddb/auto";

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RegisterPrompt } from "@/components/register-prompt";
import { getSafwaDb } from "@/modules/content/db";
import { getOrCreateDeviceProfile } from "@/modules/profile/device";
import {
  isRegisterPromptDismissed,
  SETTING_KEYS,
  writeGuestSetting,
  writeSetting,
} from "@/modules/profile/settings";

// The component reads through the real browser singleton, so tests seed and
// clear that same database.
const db = getSafwaDb();

beforeEach(async () => {
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
      expect(await isRegisterPromptDismissed(db)).toBe(true);
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
});
