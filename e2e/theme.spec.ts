import { expect, test } from "./fixtures";

test.skip(({ isMobile }) => !!isMobile, "theme covered on desktop project");

test.describe("theme", () => {
  test("selecting dark applies and persists the dark theme", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("selecting system follows the emulated colour scheme", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("theme menu communicates the selected option", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await page.getByRole("button", { name: "Theme" }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "Light" }),
    ).toHaveAttribute("aria-checked", "true");
  });
});
