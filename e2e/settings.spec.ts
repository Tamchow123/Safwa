import { expect, test } from "./fixtures";

const SCALE_PROPERTY = "--arabic-font-scale";

async function scaleValue(page: import("@playwright/test").Page) {
  return page.evaluate((prop) => {
    return document.documentElement.style.getPropertyValue(prop);
  }, SCALE_PROPERTY);
}

test.describe("appearance settings", () => {
  test("changing the Arabic text size updates the preview and persists", async ({
    page,
  }) => {
    await page.goto("/settings");
    const previewText = page
      .getByTestId("arabic-preview")
      .locator(".arabic-text-scale");
    const before = await previewText.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );

    await page.getByRole("button", { name: "Large" }).click();
    expect(await scaleValue(page)).toBe("1.2");
    await expect(page.getByText("Preview — Large")).toBeVisible();
    const after = await previewText.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));

    await page.reload();
    await expect(page.getByRole("button", { name: "Large" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(async () => scaleValue(page)).toBe("1.2");

    const stored = await page.evaluate(() =>
      window.localStorage.getItem("safwa:settings:arabic-font-scale"),
    );
    expect(stored).toBe("large");
  });

  test("reset restores the default size and system theme", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Small" }).click();
    await page
      .getByRole("group", { name: "Theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page
      .getByRole("button", { name: "Reset appearance settings" })
      .click();

    await expect(page.getByRole("button", { name: "Default" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await scaleValue(page)).toBe("1");
    await expect(
      page
        .getByRole("group", { name: "Theme" })
        .getByRole("button", { name: "System" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Appearance settings reset")).toBeVisible();
  });

  test("theme selector on the settings page switches themes", async ({
    page,
  }) => {
    await page.goto("/settings");
    const group = page.getByRole("group", { name: "Theme" });
    await group.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await group.getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });
});
