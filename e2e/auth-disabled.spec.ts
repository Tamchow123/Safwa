import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { errorAlert } from "./helpers/auth-ui";

/**
 * Phase 15 auth E2E — 60.2 authentication disabled (phases-15.md §60.2).
 * Runs ONLY against the dedicated `auth-disabled` project/server
 * (AUTH_ENABLED=false, see playwright.config.ts + e2e/helpers/e2e-server-env.ts) —
 * AUTH_ENABLED is read once and memoised per server process, so this
 * cannot share a server with any other spec.
 */

test.describe("60.2 authentication disabled", () => {
  // Every page mounts AccountMenu, whose useSession() probes the (now
  // AUTH_ENABLED=false) session endpoint on load and resolves to a falsy
  // session gracefully (account-menu.tsx's own documented design) — but
  // the underlying fetch's 503 still logs a "Failed to load resource"
  // console error, exactly the network-error class this fixture's opt-in
  // exists for. Expected everywhere in this file, not just on explicit
  // form submissions.
  test.use({ allowExpectedNetworkErrors: true });

  test("guest pages still work with no DB-backed auth request required", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("due-today-count")).toBeVisible();

    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 15_000 },
    );

    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    await page.goto("/progress");
    await expect(page).toHaveURL(/\/progress/);
  });

  test("register UI reports unavailable safely, without crashing", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(page.getByTestId("register-form")).toBeVisible();

    await page.getByLabel("Name").fill("Disabled Auth Probe");
    await page
      .getByLabel("Email")
      .fill(`e2e.auth-disabled.${randomUUID()}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill("irrelevant-pw-1");
    await page.getByLabel("Confirm password").fill("irrelevant-pw-1");
    await page.getByRole("button", { name: "Create account" }).click();

    // The client hits /api/auth/sign-up/email, which the route handler
    // rejects with a fast 503 before ever calling getAuth() — the form
    // maps any non-recognised error to its fixed generic message (never a
    // stack trace, never a raw response body).
    await expect(errorAlert(page)).toHaveText(
      "Something went wrong. Please try again.",
    );
    // Still on the register form — no verification-notice, no crash.
    await expect(page.getByTestId("register-form")).toBeVisible();
  });

  test("sign-in UI reports unavailable safely, without crashing", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByTestId("login-form")).toBeVisible();

    await page
      .getByLabel("Email")
      .fill(`e2e.auth-disabled-signin.${randomUUID()}@example.test`);
    await page.getByLabel("Password").fill("irrelevant-pw-1");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(errorAlert(page)).toHaveText(
      "Something went wrong. Please try again.",
    );
    await expect(page.getByTestId("login-form")).toBeVisible();
  });
});
