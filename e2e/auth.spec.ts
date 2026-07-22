import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { expectNoSeriousViolations } from "./helpers/axe";
import { errorAlert } from "./helpers/auth-ui";
import { bookmarksRowCount, userRowExists } from "./helpers/db-probe";
import {
  extractUrlFromMessage,
  waitForOutboxMessage,
} from "./helpers/email-outbox";
import { idbAll, idbSeed, seedBookmark, seedWeakAttempt } from "./helpers/idb";

/**
 * Phase 15 auth E2E suite (phases-15.md §60), scenarios 60.1, 60.3-60.6,
 * 60.8-60.12 — everything that runs against the normal, generously
 * rate-limited, auth-ENABLED server (the "chromium"/"mobile-chromium"
 * projects). 60.2 (AUTH_ENABLED=false) and 60.7 (rate limit) each need a
 * differently-configured server/process and live in their own spec files
 * (auth-disabled.spec.ts, auth-rate-limit.spec.ts) matched to their own
 * dedicated Playwright projects (see playwright.config.ts).
 */

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "brand-new-password-1";

function freshEmail(prefix: string): string {
  return `e2e.${prefix}.${randomUUID()}@example.test`;
}

/** Submit the register form only — does not follow the verification link. */
async function registerOnly(
  page: Page,
  email: string,
  password = PASSWORD,
  name = "E2E Learner",
): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("register-verification-notice")).toBeVisible();
}

/** Register, read the real verification email from the local outbox, and follow it. */
async function registerAndVerify(
  page: Page,
  email: string,
  password = PASSWORD,
  name = "E2E Learner",
): Promise<void> {
  await registerOnly(page, email, password, name);
  const message = await waitForOutboxMessage(email, "verify-email");
  await page.goto(extractUrlFromMessage(message));
  await expect(page.getByTestId("verify-email-success")).toBeVisible();
}

async function login(
  page: Page,
  email: string,
  password = PASSWORD,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Wait for the sign-in call + redirect to actually complete before
  // returning — otherwise a caller's immediate page.goto() to a session-
  // gated route can race the still-in-flight request.
  await expect(page).not.toHaveURL(/\/login/);
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}

/** Click the correct option for the current MC question (mirrors dashboard.spec.ts). */
async function answerCorrectly(page: Page): Promise<void> {
  const session = page.getByTestId("mc-quiz-session");
  const entryId = await session.getAttribute("data-entry-id");
  const answerField = await session.getAttribute("data-answer-field");
  await page
    .locator(
      `[data-testid="mc-option"][data-answer-ref="entry:${entryId}:field:${answerField}"]`,
    )
    .click();
}

test.describe("60.1 guest regression", () => {
  test("guest can browse, study and view progress without any registration", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("due-today-count")).toBeVisible();

    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 15_000 },
    );

    await page.goto("/library/saved");
    await expect(page).toHaveURL(/\/library\/saved/);

    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-next")).toBeVisible();

    await page.goto("/progress");
    await expect(page).toHaveURL(/\/progress/);

    // Never redirected to /login at any point above.
    expect(page.url()).not.toContain("/login");
  });
});

test.describe("60.3 register -> verify -> login -> logout", () => {
  test("full lifecycle", async ({ page }) => {
    const email = freshEmail("lifecycle");

    await registerOnly(page, email);
    // Step: confirm verification-required state (already asserted inside
    // registerOnly via register-verification-notice).

    const message = await waitForOutboxMessage(email, "verify-email");
    await page.goto(extractUrlFromMessage(message));
    await expect(page.getByTestId("verify-email-success")).toBeVisible();

    await login(page, email);
    await expect(page).not.toHaveURL(/\/login/);

    await page.goto("/account");
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Email verified")).toBeVisible();

    await logout(page);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("60.4 unverified login", () => {
  // A sign-in attempt against an unverified account is a deliberate,
  // expected failure (403 EMAIL_NOT_VERIFIED) — the exact network-error
  // class this fixture's opt-in exists for.
  test.use({ allowExpectedNetworkErrors: true });

  test("rejected safely, resend path available, no token leaked", async ({
    page,
  }) => {
    const email = freshEmail("unverified");
    await registerOnly(page, email);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(errorAlert(page)).toHaveText(
      "Verify your email address before signing in.",
    );
    await expect(page).toHaveURL(/\/login/);

    // No token leaked: the failed attempt must never establish a session
    // (Better Auth's session is an httpOnly cookie, not a page-readable
    // value — so the real proof is that no such cookie exists at all) and
    // must never surface a token in client-readable storage.
    const cookies = await page.context().cookies();
    expect(
      cookies.some((cookie) => cookie.name.includes("session_token")),
    ).toBe(false);
    const storageDump = await page.evaluate(() => ({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
    }));
    expect(JSON.stringify(storageDump)).not.toMatch(/token/i);

    // Resend path: the real shape Better Auth's own GET redirect produces
    // for an expired/invalid link. Never displays a token.
    await page.goto("/verify-email?error=INVALID_TOKEN");
    await expect(page.getByTestId("verify-email-invalid")).toBeVisible();
    expect(page.url()).not.toContain("token=");

    await page.getByLabel("Email").fill(email);
    await page
      .getByRole("button", { name: "Resend verification email" })
      .click();
    await expect(page.getByText(/a new link is on its way/i)).toBeVisible();

    const resent = await waitForOutboxMessage(email, "verify-email");
    expect(resent).toBeTruthy();
  });
});

test.describe("60.5 password reset", () => {
  // The deliberate "old password fails" step below triggers an expected
  // 401 (invalid credentials).
  test.use({ allowExpectedNetworkErrors: true });

  test("request, follow link, set new password, old fails, new works", async ({
    page,
  }) => {
    const email = freshEmail("reset");
    await registerAndVerify(page, email);

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByTestId("forgot-password-sent")).toBeVisible();

    const message = await waitForOutboxMessage(email, "reset-password");
    await page.goto(extractUrlFromMessage(message));
    await expect(page.getByTestId("reset-password-form")).toBeVisible();

    // Mismatched confirmation is rejected client-side: the submit button
    // is disabled and a mismatch message shows, so no reset is ever sent.
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByLabel("Confirm password").fill("a-completely-different-1");
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Update password" }),
    ).toBeDisabled();
    await expect(page.getByTestId("reset-password-done")).toHaveCount(0);

    await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByTestId("reset-password-done")).toBeVisible();

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(errorAlert(page)).toHaveText("Incorrect email or password.");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });
});

test.describe("60.6 enumeration safety", () => {
  test("reset request looks identical for an existing and an unknown email", async ({
    page,
  }) => {
    const existingEmail = freshEmail("enum-reset-existing");
    await registerAndVerify(page, existingEmail);

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(existingEmail);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByTestId("forgot-password-sent")).toBeVisible();
    const existingText = await page
      .getByTestId("forgot-password-sent")
      .innerText();
    await expect(errorAlert(page)).toHaveCount(0);

    await page.goto("/forgot-password");
    const unknownEmail = freshEmail("enum-reset-unknown");
    await page.getByLabel("Email").fill(unknownEmail);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByTestId("forgot-password-sent")).toBeVisible();
    const unknownText = await page
      .getByTestId("forgot-password-sent")
      .innerText();
    await expect(errorAlert(page)).toHaveCount(0);

    expect(existingText).toBe(unknownText);
  });

  test("registration looks identical for an existing and a new email", async ({
    page,
  }) => {
    const existingEmail = freshEmail("enum-register-existing");
    await registerAndVerify(page, existingEmail);

    await registerOnly(page, existingEmail, "a-different-password-1");
    await expect(errorAlert(page)).toHaveCount(0);
    const existingText = (
      await page.getByTestId("register-verification-notice").innerText()
    ).replace(existingEmail, "EMAIL");

    const newEmail = freshEmail("enum-register-new");
    await registerOnly(page, newEmail);
    await expect(errorAlert(page)).toHaveCount(0);
    const newText = (
      await page.getByTestId("register-verification-notice").innerText()
    ).replace(newEmail, "EMAIL");

    // The only expected difference is the learner's own email address
    // (which they already know), normalised out above — everything else
    // about the notice (wording, structure) must be identical regardless
    // of whether the account already existed.
    expect(existingText).toBe(newText);
  });
});

test.describe("60.8 account settings", () => {
  test("server values persist without clobbering local Dexie settings", async ({
    page,
  }) => {
    const email = freshEmail("settings");
    await registerAndVerify(page, email);
    await login(page, email);

    // A distinct DEVICE-LOCAL study default, set first.
    await page.goto("/settings");
    const localInput = page.getByTestId("study-default-questionCount");
    await expect(localInput).toBeEnabled();
    await localInput.fill("7");
    await page.getByTestId("study-defaults-save").click();

    // A DIFFERENT SERVER-SAVED study default + theme, via /account/settings.
    await page.goto("/account/settings");
    await expect(page.getByTestId("account-settings-form")).toBeVisible();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    const serverInput = page.getByLabel("Questions per session");
    await serverInput.fill("9");
    await page.getByRole("button", { name: "Save account settings" }).click();
    await expect(page.getByText("Account settings saved")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("account-settings-form")).toBeVisible();
    await expect(page.getByLabel("Questions per session")).toHaveValue("9");
    await expect(
      page.getByRole("button", { name: "Dark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    // The device-local value must be untouched by the server-side save.
    await page.goto("/settings");
    await expect(page.getByTestId("study-default-questionCount")).toHaveValue(
      "7",
    );
  });
});

test.describe("60.9 local guest data survives login/logout", () => {
  test("no merge or upload occurs", async ({ page }) => {
    const beforeCount = await bookmarksRowCount();

    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 15_000 },
    );
    await idbSeed(page, "bookmarks", [seedBookmark(1, Date.now())]);
    await idbSeed(page, "study_attempts", [
      seedWeakAttempt({
        id: "e2e-guest-progress",
        componentKey: "entry:1:skill:meaning_recall",
        entryId: 1,
        skillTypeId: "meaning_recall",
        isCorrect: true,
        occurredAtMs: Date.now(),
      }),
    ]);
    const seededBookmarks = await idbAll(page, "bookmarks");
    expect(seededBookmarks).toHaveLength(1);

    const email = freshEmail("guest-persist");
    await registerAndVerify(page, email);
    await login(page, email);
    await expect(await idbAll(page, "bookmarks")).toHaveLength(1);

    await logout(page);
    await expect(await idbAll(page, "bookmarks")).toHaveLength(1);

    const afterCount = await bookmarksRowCount();
    expect(afterCount).toBe(beforeCount);
  });
});

test.describe("60.10 delete account", () => {
  // The deliberate post-deletion login attempt below triggers an expected
  // 401 (the account no longer exists).
  test.use({ allowExpectedNetworkErrors: true });

  test("session invalid, login fails, local Dexie untouched, server rows gone", async ({
    page,
  }) => {
    const email = freshEmail("delete");
    await registerAndVerify(page, email);
    await login(page, email);

    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 15_000 },
    );
    await idbSeed(page, "bookmarks", [seedBookmark(2, Date.now())]);

    // "Create account settings" step.
    await page.goto("/account/settings");
    await page.getByLabel("Questions per session").fill("11");
    await page.getByRole("button", { name: "Save account settings" }).click();
    await expect(page.getByText("Account settings saved")).toBeVisible();

    await page.goto("/account");
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByLabel("Password").fill(PASSWORD);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete account" })
      .click();
    await expect(page.getByText(/Check your email/)).toBeVisible();

    const message = await waitForOutboxMessage(email, "delete-account");
    await page.goto(extractUrlFromMessage(message));

    // Session invalid: /account now redirects to /login.
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login/);

    // Login fails with the (now-deleted) account's credentials.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(errorAlert(page)).toHaveText("Incorrect email or password.");

    // Local Dexie data untouched.
    await expect(await idbAll(page, "bookmarks")).toHaveLength(1);

    // Server personal rows gone.
    expect(await userRowExists(email)).toBe(false);
  });
});

test.describe("60.11 mobile auth flows", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile auth flows only");

  test("register, verify, login, account, reset request, logout at 320px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const email = freshEmail("mobile");

    await registerAndVerify(page, email);
    await login(page, email);

    await page.goto("/account");
    await expect(page.getByText(email)).toBeVisible();

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByTestId("forgot-password-sent")).toBeVisible();

    await page.goto("/account");
    await logout(page);

    // No horizontal overflow on any visited page at 320px.
    for (const route of [
      "/register",
      "/login",
      "/account",
      "/forgot-password",
    ]) {
      await page.goto(route === "/account" ? "/login" : route);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });

  test.describe("error states", () => {
    // A deliberate wrong-password attempt below triggers an expected 401.
    test.use({ allowExpectedNetworkErrors: true });

    test("error states render fully readable with no overflow at 320px", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 700 });

      await page.goto("/login");
      await page.getByLabel("Email").fill(freshEmail("mobile-error"));
      await page.getByLabel("Password").fill("wrong-password-on-purpose");
      await page.getByRole("button", { name: "Sign in" }).click();

      const alert = errorAlert(page);
      await expect(alert).toHaveText("Incorrect email or password.");
      const box = await alert.boundingBox();
      expect(box).not.toBeNull();
      // Fully within the 320px viewport — not clipped/overflowing off-screen.
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});

test.describe("60.12 accessibility", () => {
  test("register page", async ({ page }) => {
    await page.goto("/register");
    await expectNoSeriousViolations(page);
  });

  test("login page", async ({ page }) => {
    await page.goto("/login");
    await expectNoSeriousViolations(page);
  });

  test("verification-required state", async ({ page }) => {
    const email = freshEmail("a11y-verify-required");
    await registerOnly(page, email);
    await expectNoSeriousViolations(page);
  });

  test("verify success state", async ({ page }) => {
    const email = freshEmail("a11y-verify-success");
    await registerAndVerify(page, email);
    await expectNoSeriousViolations(page);
  });

  test("forgot password page", async ({ page }) => {
    await page.goto("/forgot-password");
    await expectNoSeriousViolations(page);
  });

  test("reset password page (invalid-link state)", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByTestId("reset-password-invalid")).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("account and account settings pages", async ({ page }) => {
    const email = freshEmail("a11y-account");
    await registerAndVerify(page, email);
    await login(page, email);

    await page.goto("/account");
    await expectNoSeriousViolations(page);

    await page.goto("/account/settings");
    await expect(page.getByTestId("account-settings-form")).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("delete-confirmation dialog", async ({ page }) => {
    const email = freshEmail("a11y-delete");
    await registerAndVerify(page, email);
    await login(page, email);

    await page.goto("/account");
    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByTestId("delete-account-dialog")).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("register page in dark mode", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("theme", "dark");
    });
    await page.goto("/register");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectNoSeriousViolations(page);
  });

  test("login page in dark mode", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("theme", "dark");
    });
    await page.goto("/login");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectNoSeriousViolations(page);
  });
});
