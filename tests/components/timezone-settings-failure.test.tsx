/**
 * Timezone picker save-failure path (Phase 12 §10.4; full-phase review
 * TEST-P101): a failed durable write surfaces the user-safe toast (never
 * the raw error), shows the transient "Saving…" status while pending, and
 * re-enables the picker on its prior value afterwards. The happy paths
 * live in timezone-settings.test.tsx against the real Dexie singleton;
 * this file isolates the failure branch by mocking the preference hook.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TimezoneSettings } from "@/components/settings/timezone-settings";

const toast = vi.fn();
vi.mock("sonner", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

let updateImpl: (next: unknown) => Promise<void>;
vi.mock("@/lib/preferences/use-timezone", () => ({
  useTimezonePreference: () => ({
    preference: { mode: "browser" as const },
    loaded: true,
    detectedTimezone: "UTC",
    update: (next: unknown) => updateImpl(next),
  }),
}));

beforeEach(() => {
  toast.mockClear();
});

describe("TimezoneSettings save failure", () => {
  it("shows Saving… while pending, then a user-safe toast and a re-enabled picker", async () => {
    let rejectSave!: (error: Error) => void;
    updateImpl = () =>
      new Promise<void>((_, reject) => {
        rejectSave = reject;
      });

    render(<TimezoneSettings />);
    const select = screen.getByLabelText<HTMLSelectElement>("Timezone");
    const user = userEvent.setup();
    await user.selectOptions(select, "UTC");

    // Interim state: the picker is locked and announces the save.
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(select).toBeDisabled();

    await act(async () => {
      rejectSave(new Error("Dexie internal: settings write failed"));
    });

    // The failure surfaces ONLY the fixed user-safe copy…
    expect(toast).toHaveBeenCalledWith("Couldn't save the timezone", {
      description: "Please try again.",
    });
    expect(JSON.stringify(toast.mock.calls)).not.toContain("Dexie");
    // …and the picker recovers on its prior (unchanged) preference.
    expect(select).toBeEnabled();
    expect(select.value).toBe("__browser__");
    expect(screen.queryByText("Saving…")).toBeNull();
  });
});
