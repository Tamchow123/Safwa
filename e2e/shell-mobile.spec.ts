import { expect, test } from "./fixtures";

test.skip(({ isMobile }) => !isMobile, "mobile shell only");

test.describe("mobile shell", () => {
  test("shows bottom navigation and hides the desktop sidebar", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("mobile-nav")).toBeVisible();
    await expect(page.getByTestId("app-sidebar")).toBeHidden();
  });

  test("navigates between tabs with visible labels", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByTestId("mobile-nav");

    for (const name of ["Study", "Library", "Progress", "Settings"]) {
      const link = nav.getByRole("link", { name });
      await expect(link.getByText(name)).toBeVisible();
      await link.click();
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await expect(nav.locator('[aria-current="page"]')).toHaveText(name);
    }
  });

  test("content is not obscured by the bottom navigation", async ({ page }) => {
    await page.goto("/");
    await page.mouse.wheel(0, 10_000);
    const card = page.locator("main [data-slot='card']").first();
    const cardBox = await card.boundingBox();
    const navBox = await page.getByTestId("mobile-nav").boundingBox();
    expect(cardBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  });

  test("no horizontal overflow at 320px width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    for (const route of ["/", "/study", "/library", "/progress", "/settings"]) {
      await page.goto(route);
      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        return el.scrollWidth - el.clientWidth;
      });
      expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(
        0,
      );
    }
  });

  test("tab touch targets are at least 44px tall", async ({ page }) => {
    await page.goto("/");
    const links = page.getByTestId("mobile-nav").getByRole("link");
    for (const link of await links.all()) {
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
