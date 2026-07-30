import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Touch-target sizes in the app shell (Phase 18, slice 12 — phases-18.md §8).
 *
 * The header controls were 28–32px, which is fine with a mouse and marginal
 * with a thumb. This phase installs the app to a phone home screen, where there
 * is no browser chrome to aim around and the whole surface is thumb-driven, so
 * §8 raises them to a 44px hit area **via padding only** — the icons keep their
 * size and nothing looks different.
 *
 * Asserted from the rendered box rather than from a class name, because the
 * class is not the requirement: a later utility change, a conflicting
 * `size="icon"` rule, or a flex parent that squashes the button would all keep
 * the class and lose the property.
 *
 * Runs on both projects. The two engines resolve Tailwind's minimums through
 * different layout paths, and a control that is 44px in Chromium and 36px in
 * WebKit is a bug on the exact platform §8 is about.
 */
const MINIMUM_HIT_AREA_PX = 44;

async function expectHitArea(control: Locator, name: string): Promise<void> {
  await expect(control, name).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${name} has no box`).not.toBeNull();
  // Rounded down by a fraction of a pixel on some device-scale factors, so the
  // comparison allows the sub-pixel rather than demanding an exact 44.
  expect(Math.round(box!.width), `${name} width`).toBeGreaterThanOrEqual(
    MINIMUM_HIT_AREA_PX,
  );
  expect(Math.round(box!.height), `${name} height`).toBeGreaterThanOrEqual(
    MINIMUM_HIT_AREA_PX,
  );
}

test.describe("§8 44px hit areas", () => {
  test("the theme toggle is thumb-sized", async ({ page }) => {
    await page.goto("/");
    await expectHitArea(
      page.getByRole("button", { name: "Theme" }),
      "theme toggle",
    );
  });

  test("the signed-out header actions are thumb-sized", async ({ page }) => {
    // Height only for these two: they are text buttons and already far wider
    // than 44px, so a width minimum would assert nothing.
    await page.goto("/");
    for (const name of ["Sign in", "Create account"]) {
      const control = page.getByRole("link", { name });
      await expect(control, name).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${name} has no box`).not.toBeNull();
      expect(Math.round(box!.height), `${name} height`).toBeGreaterThanOrEqual(
        MINIMUM_HIT_AREA_PX,
      );
    }
  });
});
