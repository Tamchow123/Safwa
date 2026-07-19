import "fake-indexeddb/auto";

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TimezoneSettings } from "@/components/settings/timezone-settings";
import { getSafwaDb } from "@/modules/content/db";
import { readSetting, SETTING_KEYS } from "@/modules/profile/settings";
import {
  detectBrowserTimezone,
  readTimezonePreference,
} from "@/modules/profile/timezone";

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

/** Flush the component's async Dexie read (IndexedDB resolves on macrotasks). */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe("TimezoneSettings", () => {
  it("renders a labelled picker defaulting to the browser zone", async () => {
    render(<TimezoneSettings />);
    await flush();
    const select = screen.getByLabelText<HTMLSelectElement>("Timezone");
    expect(select).toBeEnabled();
    expect(select.value).toBe("__browser__");
    // The detected browser zone is stated visibly.
    expect(
      screen.getByText(
        new RegExp(
          `Detected browser timezone: ${detectBrowserTimezone().replace(/\//g, "\\/")}`,
        ),
      ),
    ).toBeInTheDocument();
  });

  it("offers the browser option, UTC and the detected zone", async () => {
    render(<TimezoneSettings />);
    await flush();
    const select = screen.getByLabelText<HTMLSelectElement>("Timezone");
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toContain("__browser__");
    expect(values).toContain("UTC");
    expect(values).toContain(detectBrowserTimezone());
  });

  it("saves an explicit IANA choice durably", async () => {
    render(<TimezoneSettings />);
    await flush();
    const user = userEvent.setup();
    const select = screen.getByLabelText<HTMLSelectElement>("Timezone");
    await user.selectOptions(select, "UTC");
    await waitFor(async () => {
      expect(await readTimezonePreference(db)).toEqual({
        mode: "iana",
        timezone: "UTC",
      });
    });
    expect(select.value).toBe("UTC");
  });

  it("returns to browser mode when the browser option is selected", async () => {
    render(<TimezoneSettings />);
    await flush();
    const user = userEvent.setup();
    const select = screen.getByLabelText<HTMLSelectElement>("Timezone");
    await user.selectOptions(select, "UTC");
    await waitFor(async () => {
      expect(await readTimezonePreference(db)).toEqual({
        mode: "iana",
        timezone: "UTC",
      });
    });
    await user.selectOptions(select, "__browser__");
    await waitFor(async () => {
      expect(await readTimezonePreference(db)).toEqual({ mode: "browser" });
    });
  });

  it("shows a stored invalid zone as browser mode (sanitised on read)", async () => {
    await db.settings.put({
      key: SETTING_KEYS.timezone,
      value: { mode: "iana", timezone: "Broken/Zone" },
      updatedAt: 1,
    });
    render(<TimezoneSettings />);
    await flush();
    expect(screen.getByLabelText<HTMLSelectElement>("Timezone").value).toBe(
      "__browser__",
    );
    // The corrupt stored row itself is untouched by a passive read.
    expect(await readSetting(db, SETTING_KEYS.timezone)).toEqual({
      mode: "iana",
      timezone: "Broken/Zone",
    });
  });

  it("states that history keeps its original dates", async () => {
    render(<TimezoneSettings />);
    await flush();
    expect(
      screen.getByText(/recorded activity keeps its original dates/i),
    ).toBeInTheDocument();
  });
});
