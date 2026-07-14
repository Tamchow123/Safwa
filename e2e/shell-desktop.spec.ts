import { expect, test } from "./fixtures";

test.skip(({ isMobile }) => !!isMobile, "desktop shell only");

test.describe("desktop shell", () => {
  test("shows the sidebar, hides mobile navigation, has the right title", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Safwa");
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    await expect(page.getByTestId("mobile-nav")).toBeHidden();
    await expect(
      page.getByTestId("app-sidebar").getByText("Safwa"),
    ).toBeVisible();
  });

  test("navigates all primary destinations with correct active state", async ({
    page,
  }) => {
    await page.goto("/");
    const sidebar = page.getByTestId("app-sidebar");

    for (const { name, heading } of [
      { name: "Study", heading: "Study" },
      { name: "Library", heading: "Library" },
      { name: "Progress", heading: "Progress" },
      { name: "Settings", heading: "Settings" },
      { name: "Dashboard", heading: "Dashboard" },
    ]) {
      await sidebar.getByRole("link", { name }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      const active = sidebar.locator('[aria-current="page"]');
      await expect(active).toHaveCount(1);
      await expect(active).toHaveText(name);
    }
  });

  test("skip link focuses the main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("keyboard focus is visible on navigation links", async ({ page }) => {
    await page.goto("/");
    const studyLink = page
      .getByTestId("app-sidebar")
      .getByRole("link", { name: "Study" });
    await studyLink.focus();
    const outlineWidth = await studyLink.evaluate(
      (el) => getComputedStyle(el).outlineWidth,
    );
    expect(outlineWidth).not.toBe("0px");
  });
});
