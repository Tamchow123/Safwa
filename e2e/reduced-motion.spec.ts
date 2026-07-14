import { expect, test } from "./fixtures";

test.describe("reduced motion", () => {
  test("app remains usable and transitions are effectively disabled", async ({
    page,
    isMobile,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    // Representative transitioned element: a primary navigation link.
    const nav = isMobile
      ? page.getByTestId("mobile-nav")
      : page.getByTestId("app-sidebar");
    const link = nav.getByRole("link", { name: "Library" });
    const duration = await link.evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    );
    // 0.01ms computes to at most 0.00001s in any engine representation.
    const seconds = parseFloat(duration);
    expect(seconds).toBeLessThanOrEqual(0.001);

    // Navigation still works with animations reduced.
    await link.click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Library" }),
    ).toBeVisible();
  });
});
