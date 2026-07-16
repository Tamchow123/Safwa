import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./fixtures";

/** Fail on serious/critical violations; report everything found. */
async function expectNoSeriousViolations(
  page: import("@playwright/test").Page,
) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    serious.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}

test.describe("accessibility", () => {
  test("dashboard shell in light mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expectNoSeriousViolations(page);
  });

  test("settings page in light mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/settings");
    await expectNoSeriousViolations(page);
  });

  test("library with loaded content in light mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 15_000 },
    );
    await expectNoSeriousViolations(page);
  });

  test("filtered library page", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/library?bab=nasara&eligibility=eligible%3Amasdar");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /match your filters/,
      { timeout: 15_000 },
    );
    await expectNoSeriousViolations(page);
  });

  test("vocabulary detail page", async ({ page }) => {
    await page.goto("/library/1");
    await expect(page.getByTestId("detail-madi")).toBeVisible({
      timeout: 15_000,
    });
    await expectNoSeriousViolations(page);
  });

  test("detail page with an ineligible field (entry 369)", async ({ page }) => {
    await page.goto("/library/369");
    await expect(page.getByTestId("detail-root")).toBeVisible({
      timeout: 15_000,
    });
    await expectNoSeriousViolations(page);
  });

  test("settings page in dark mode", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("theme", "dark");
    });
    await page.goto("/settings");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectNoSeriousViolations(page);
  });
});
