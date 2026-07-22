import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { errorAlert } from "./helpers/auth-ui";

/**
 * Phase 15 auth E2E — 60.7 rate limit (phases-15.md §60.7). Runs ONLY
 * against the dedicated `auth-rate-limit` project/server (deliberately
 * tight AUTH_RATE_LIMIT_MAX=3/AUTH_RATE_LIMIT_WINDOW_SECONDS=30 — see
 * playwright.config.ts + e2e/helpers/e2e-server-env.ts), never the
 * generously-limited main server every other spec uses, so this can drive
 * a real 429 through the UI without waiting out a production-sized window
 * or interfering with unrelated tests' auth traffic.
 */

test.describe("60.7 rate limit", () => {
  // Every wrong-password/rate-limited attempt below is a deliberately
  // failed sign-in (401) or an intentionally-triggered 429 — both surface
  // as a "Failed to load resource" console error even though the UI
  // handles each one correctly.
  test.use({ allowExpectedNetworkErrors: true });

  test("429 is handled, retry message appears, form usable again after the window", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    const email = `e2e.rate-limit.${randomUUID()}@example.test`;
    await page.goto("/login");

    // Exhaust the configured limit (max 3 per 30s) with wrong-password
    // attempts against a non-existent account — no real account is needed
    // to exercise the rate limit itself.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("wrong-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(errorAlert(page)).toHaveText("Incorrect email or password.");
    }

    // The next attempt is the 4th within the window — rejected as 429,
    // mapped to the fixed rate-limit message (never the raw status code).
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(errorAlert(page)).toHaveText(
      "Too many attempts. Please wait a moment and try again.",
    );

    // Form remains usable (not stuck disabled) — the button is still
    // clickable, it just needs the window to lapse.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();

    // Wait out the configured 30s window, then confirm the form works
    // again — a normal wrong-password error, not another 429.
    await page.waitForTimeout(31_000);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(errorAlert(page)).toHaveText("Incorrect email or password.");
  });
});
