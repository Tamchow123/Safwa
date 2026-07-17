import { readFileSync } from "node:fs";

import { chromium, type Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const SCALE_KEY = "safwa:settings:arabic-font-scale";
const SCALE_PROPERTY = "--arabic-font-scale";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PersistProbeWindow = Window & { __persistCalls: number };

type ProfileRow = {
  deviceId: string;
  persistenceRequestedAt: number | null;
  persistenceGranted: boolean | null;
} | null;

/**
 * Replace navigator.storage.persist with a counting mock BEFORE any app
 * code runs, so the "persist requested on first progress" assertion tests
 * the app's behaviour, not the browser's heuristics.
 */
async function mockPersist(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as PersistProbeWindow).__persistCalls = 0;
    if (typeof StorageManager !== "undefined") {
      StorageManager.prototype.persist = async function persist() {
        (window as unknown as PersistProbeWindow).__persistCalls += 1;
        return true;
      };
    }
  });
}

function persistCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as PersistProbeWindow).__persistCalls,
  );
}

/** Read a row from the app's IndexedDB directly (independent of app code). */
function readIdbRow(page: Page, store: string, key: string): Promise<unknown> {
  return page.evaluate(
    async ({ store, key }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("safwa-content");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) return null;
        return await new Promise((resolve, reject) => {
          const request = database
            .transaction(store, "readonly")
            .objectStore(store)
            .get(key);
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    },
    { store, key },
  );
}

function readProfile(page: Page): Promise<ProfileRow> {
  return readIdbRow(page, "profile", "device") as Promise<ProfileRow>;
}

async function readStoredScale(page: Page): Promise<string | null> {
  const row = (await readIdbRow(page, "settings", "arabic-font-scale")) as {
    value?: string;
  } | null;
  return row?.value ?? null;
}

function scaleValue(page: Page): Promise<string> {
  return page.evaluate(
    (prop) => document.documentElement.style.getPropertyValue(prop),
    SCALE_PROPERTY,
  );
}

test.describe("guest identity & local persistence", () => {
  test("persistent storage is requested on first progress, not on page load", async ({
    page,
  }) => {
    await mockPersist(page);
    await page.goto("/settings");

    // Passive load produces no identity and no permission-prompting call.
    expect(await persistCalls(page)).toBe(0);
    expect(await readProfile(page)).toBeNull();

    // First durable guest action.
    await page.getByRole("button", { name: "Large" }).click();
    await expect.poll(() => persistCalls(page)).toBeGreaterThan(0);

    const profile = await readProfile(page);
    expect(profile).not.toBeNull();
    expect(profile!.deviceId).toMatch(UUID_PATTERN);
    expect(profile!.persistenceGranted).toBe(true);
    expect(profile!.persistenceRequestedAt).not.toBeNull();
  });

  test("guest state survives reload through Dexie even when localStorage is cleared", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Large" }).click();
    await expect.poll(() => readStoredScale(page)).toBe("large");

    // Clearing the synchronous mirror must NOT lose the setting: Dexie is
    // the durable authority and restores it on next load.
    await page.evaluate(
      (key) => window.localStorage.removeItem(key),
      SCALE_KEY,
    );
    await page.reload();

    await expect(page.getByRole("button", { name: "Large" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(() => scaleValue(page)).toBe("1.2");
    await expect
      .poll(() =>
        page.evaluate((key) => window.localStorage.getItem(key), SCALE_KEY),
      )
      .toBe("large");
  });

  test("the device identity is stable across reloads and further actions", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Small" }).click();
    await expect
      .poll(async () => (await readProfile(page)) !== null)
      .toBe(true);
    const before = (await readProfile(page))!.deviceId;

    await page.reload();
    await page.getByRole("button", { name: "Large" }).click();
    await expect.poll(() => readStoredScale(page)).toBe("large");
    const after = (await readProfile(page))!.deviceId;

    expect(before).toMatch(UUID_PATTERN);
    expect(after).toBe(before);
  });

  test("settings and profile survive a full browser restart", async ({
    baseURL,
  }, testInfo) => {
    // The phase demonstrates durability across a real RESTART, not just a
    // reload: a persistent user-data dir, the browser process closed, then
    // relaunched from the same dir. page.reload() cannot prove this.
    const userDataDir = testInfo.outputPath("restart-user-data");
    const launch = () => chromium.launchPersistentContext(userDataDir);

    let deviceIdBefore = "";
    let context = await launch();
    try {
      const page = await context.newPage();
      await page.goto(`${baseURL}/settings`);
      await page.getByRole("button", { name: "Large" }).click();
      await expect.poll(() => readStoredScale(page)).toBe("large");
      await expect
        .poll(async () => (await readProfile(page)) !== null)
        .toBe(true);
      deviceIdBefore = (await readProfile(page))!.deviceId;
      expect(deviceIdBefore).toMatch(UUID_PATTERN);
    } finally {
      await context.close();
    }

    context = await launch();
    try {
      const page = await context.newPage();
      await page.goto(`${baseURL}/settings`);
      await expect(page.getByRole("button", { name: "Large" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect.poll(() => scaleValue(page)).toBe("1.2");
      const profileAfter = await readProfile(page);
      expect(profileAfter).not.toBeNull();
      expect(profileAfter!.deviceId).toBe(deviceIdBefore);
    } finally {
      await context.close();
    }
  });

  test("theme choice is a durable guest action and is restored from Dexie", async ({
    page,
  }) => {
    await mockPersist(page);
    await page.goto("/settings");
    expect(await persistCalls(page)).toBe(0);

    // Selecting a theme is a first durable guest action: it mints the
    // profile, requests persistence and lands in the Dexie settings store.
    await page.getByRole("button", { name: "Dark" }).click();
    await expect.poll(() => persistCalls(page)).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const row = (await readIdbRow(page, "settings", "theme")) as {
          value?: string;
        } | null;
        return row?.value ?? null;
      })
      .toBe("dark");
    expect(await readProfile(page)).not.toBeNull();

    // Clearing next-themes' localStorage mirror must NOT lose the theme:
    // Dexie is the durable authority and restores it on next load.
    await page.evaluate(() => window.localStorage.removeItem("theme"));
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(true);
  });

  test("removing the theme mirror in ANOTHER tab does not lose the durable theme", async ({
    page,
    context,
  }) => {
    // next-themes reacts to a cross-tab removal of its key by writing its
    // default back into the mirror; without the removal watcher that
    // write-back would win the next mirror-vs-Dexie divergence check and
    // silently replace the durable choice.
    await page.goto("/settings");
    await page.getByRole("button", { name: "Dark" }).click();
    await expect
      .poll(async () => {
        const row = (await readIdbRow(page, "settings", "theme")) as {
          value?: string;
        } | null;
        return row?.value ?? null;
      })
      .toBe("dark");

    const other = await context.newPage();
    try {
      await other.goto("/");
      await other.evaluate(() => window.localStorage.removeItem("theme"));

      // The first tab restores the durable value over next-themes'
      // default write-back: mirror, applied class and Dexie all stay dark.
      await expect
        .poll(() => page.evaluate(() => window.localStorage.getItem("theme")))
        .toBe("dark");
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        )
        .toBe(true);
      const row = (await readIdbRow(page, "settings", "theme")) as {
        value?: string;
      } | null;
      expect(row?.value).toBe("dark");
    } finally {
      await other.close();
    }
  });

  test("export downloads valid JSON containing the guest's data", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Large" }).click();
    await expect.poll(() => readStoredScale(page)).toBe("large");

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-my-data").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(
      /^safwa-export-\d{4}-\d{2}-\d{2}\.json$/,
    );
    const path = await download.path();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      export_schema_version: number;
      app: string;
      device_profile: { deviceId: string } | null;
      settings: Array<{ key: string; value: unknown }>;
    };
    expect(parsed.export_schema_version).toBe(1);
    expect(parsed.app).toBe("safwa");
    expect(parsed.device_profile!.deviceId).toMatch(UUID_PATTERN);
    expect(parsed.settings).toContainEqual(
      expect.objectContaining({ key: "arabic-font-scale", value: "large" }),
    );
    await expect(page.getByText("Data exported")).toBeVisible();
  });

  test("register prompt appears after first progress and dismisses durably", async ({
    page,
  }) => {
    // A fresh guest with no local state sees no prompt.
    await page.goto("/");
    await expect(page.getByTestId("register-prompt")).toHaveCount(0);

    // First progress mints the profile.
    await page.goto("/settings");
    await page.getByRole("button", { name: "Large" }).click();
    await expect
      .poll(async () => (await readProfile(page)) !== null)
      .toBe(true);

    await page.goto("/");
    await expect(page.getByTestId("register-prompt")).toBeVisible();

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("register-prompt")).toHaveCount(0);
    await expect
      .poll(async () => {
        const row = (await readIdbRow(
          page,
          "settings",
          "register-prompt-dismissed",
        )) as { value?: unknown } | null;
        return row?.value === true;
      })
      .toBe(true);

    // The dismissal is durable: still hidden after a reload.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Dashboard",
    );
    await expect(page.getByTestId("register-prompt")).toHaveCount(0);
  });

  test("register prompt appears in place when first progress happens on the dashboard", async ({
    page,
    isMobile,
  }) => {
    test.skip(!!isMobile, "the header theme toggle is a desktop control");
    // A fresh guest is ON the dashboard (prompt mounted, hidden) and makes
    // their first durable action from the header theme toggle — the prompt
    // must surface without any navigation or reload.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Dashboard",
    );
    await expect(page.getByTestId("register-prompt")).toHaveCount(0);

    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();

    await expect(page.getByTestId("register-prompt")).toBeVisible();
  });
});
