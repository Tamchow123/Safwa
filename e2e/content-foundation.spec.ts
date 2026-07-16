import { expect, test } from "./fixtures";

const READY = /entries loaded/;

async function waitForReady(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("content-status")).toHaveText(READY, {
    timeout: 15_000,
  });
}

test.describe("content foundation (/library)", () => {
  test("server-only artifacts are not publicly reachable", async ({ page }) => {
    await page.goto("/library");
    for (const url of [
      "/content-server/README.md",
      "/content-server/releases",
    ]) {
      const response = await page.request.get(url);
      expect(response.status(), url).toBe(404);
    }
    // The public learner artifact IS reachable.
    const pointer = await (
      await page.request.get("/content/active.json")
    ).json();
    const learner = await page.request.get(
      (pointer as { learner_url: string }).learner_url,
    );
    expect(learner.status()).toBe(200);
  });

  test("first load downloads, verifies and shows the release", async ({
    page,
  }) => {
    await page.goto("/library");
    await waitForReady(page);

    await expect(page.getByTestId("content-entry-count")).toHaveText("455");
    await expect(page.getByTestId("content-release-id")).toContainText(
      /^safwa-/,
    );
    const arabic = page.getByTestId("content-sample-arabic");
    await expect(arabic).toBeVisible();
    await expect(arabic).toHaveAttribute("lang", "ar");
    await expect(arabic).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("content-sample-meaning")).not.toBeEmpty();
  });

  test("second load uses the existing cache without re-downloading", async ({
    page,
  }) => {
    let learnerDownloads = 0;
    await page.route("**/content/releases/**", async (route) => {
      learnerDownloads += 1;
      await route.continue();
    });

    await page.goto("/library");
    await waitForReady(page);
    expect(learnerDownloads).toBe(1);

    await page.getByRole("button", { name: "Reload content" }).click();
    await waitForReady(page);
    await expect(page.getByTestId("content-source")).toHaveText(
      "served from verified cache",
    );
    expect(learnerDownloads).toBe(1); // no second learner download
  });

  test("a corrupt learner response is rejected and the valid cache survives", async ({
    page,
  }) => {
    // Populate a valid cache first.
    await page.goto("/library");
    await waitForReady(page);
    const validReleaseId = await page
      .getByTestId("content-release-id")
      .textContent();

    // Point at a "new" release whose bytes won't match its checksum.
    await page.route("**/content/active.json", async (route) => {
      const response = await route.fetch();
      const pointer = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        json: {
          ...pointer,
          release_id: "safwa-2.2.0-corrupt00000",
          learner_url:
            "/content/releases/safwa-2.2.0-corrupt00000/learner.json",
        },
      });
    });
    await page.route(
      "**/content/releases/safwa-2.2.0-corrupt00000/**",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"release_id":"safwa-2.2.0-corrupt00000","tampered":true}',
        });
      },
    );

    await page.getByRole("button", { name: "Reload content" }).click();
    await waitForReady(page);
    // Corrupt release rejected; previously valid cache still serves content.
    // Not an offline case, so the label must not claim offline.
    await expect(page.getByTestId("content-source")).toHaveText(
      "using the previous verified cached release",
    );
    await expect(page.getByTestId("content-release-id")).toHaveText(
      validReleaseId ?? "",
    );
    await expect(page.getByTestId("content-entry-count")).toHaveText("455");
  });
});

test.describe("content foundation — offline fallback", () => {
  // This suite deliberately disconnects the network; resource-load errors
  // are expected. Hydration/runtime errors are still caught by the guard.
  test.use({ allowExpectedNetworkErrors: true });

  test("offline fallback serves the cached release without a reload", async ({
    page,
    context,
  }) => {
    await page.goto("/library");
    await waitForReady(page);

    await context.setOffline(true);
    await page.getByRole("button", { name: "Reload content" }).click();
    await waitForReady(page);
    await expect(page.getByTestId("content-source")).toHaveText(
      "using the previous verified cached release (offline)",
    );
    await expect(page.getByTestId("content-entry-count")).toHaveText("455");
    await expect(page.getByTestId("content-sample-arabic")).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe("console-error guard", () => {
  test("ordinary tests fail on unexpected resource errors", async ({
    page,
  }) => {
    // Marked as expected-failure: the strict guard must fail this test
    // because of the deliberately missing resource. If the guard stops
    // catching resource errors, this test "passes" and the suite fails.
    test.fail();
    await page.goto("/library");
    await page.evaluate(() => fetch("/definitely-missing-resource.js"));
    await page.waitForTimeout(250);
  });
});
