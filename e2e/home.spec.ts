import { expect, test } from "@playwright/test";

test.describe("home page", () => {
  test("shows the Safwa heading and title", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { level: 1, name: "Safwa" }),
    ).toBeVisible();
    await expect(page).toHaveTitle("Safwa");
  });
});
