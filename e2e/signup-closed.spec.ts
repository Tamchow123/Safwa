import { expect, test } from "./fixtures";
import {
  fillAndSubmitRegisterForm,
  freshEmail,
  submitRegistration,
} from "./helpers/auth-flows";
import { errorAlert } from "./helpers/auth-ui";
import { userRowExists } from "./helpers/db-probe";
import { E2E_ALLOWED_SIGNUP_EMAIL } from "./helpers/e2e-server-env";

/**
 * Sign-up allowlist (phases-18.md §5 slice 6). Runs ONLY against the dedicated
 * `signup-closed` server, the only E2E server booted with
 * `SIGNUP_ALLOWED_EMAILS` set — every other one leaves it unset so its specs
 * can register throwaway accounts freely.
 *
 * The rule itself is proved deterministically against real Better Auth in
 * tests/integration/auth-signup-allowlist.test.ts. What only a browser can show
 * is whether the refusal is USABLE: that the form says something true and
 * final rather than the generic "Something went wrong. Please try again." a
 * person would obey forever, that the app does not pretend the account was
 * created, and that the owner can correct a mistyped address in place.
 */
const REFUSAL = "This app is not accepting new accounts.";

// Top level, not inside the describe: Playwright refuses `test.use({ trace })`
// in a describe group because it would force a new worker.
//
// `trace: "off"` per e2e/helpers/auth-flows.ts's standing rule for its
// importers. This spec never reads a token from the outbox, so the leak that
// rule guards against is not reachable here — but the rule is file-scoped by
// design, so a later test added to this file inherits the protection instead
// of having to remember it.
//
// `allowExpectedNetworkErrors` because the deliberate 403 surfaces as a
// "Failed to load resource" console error even though the UI handles it
// correctly — the same allowance the rate-limit spec makes for its 429.
test.use({ allowExpectedNetworkErrors: true, trace: "off" });

// `.serial` because the third test PERMANENTLY registers the one allowlisted
// address (`E2E_ALLOWED_SIGNUP_EMAIL`) in the shared `safwa_test` database.
// That is safe exactly once per `playwright test` invocation, because
// e2e/global-setup.ts resets the database at the start of each one. It is not
// safe twice: running this config with `--repeat-each` or `--shuffle` makes
// the second attempt collide with the account the first one created, and
// Better Auth's duplicate rejection then reads as a UI regression rather than
// the fixture collision it is. Serial declares the ordering this file relies
// on; this comment is the part that saves the debugging time.
test.describe.serial("sign-up allowlist (SIGNUP_ALLOWED_EMAILS set)", () => {
  test("a non-allowlisted address is refused, and nothing is created", async ({
    page,
  }) => {
    const email = freshEmail("stranger");

    await submitRegistration(page, email);

    await expect(errorAlert(page)).toHaveText(REFUSAL);
    // No false success: the "check your email" panel must not appear, and the
    // form must still be the thing on screen.
    await expect(page.getByTestId("register-verification-notice")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("register-form")).toBeVisible();
    expect(await userRowExists(email)).toBe(false);
  });

  test("the refusal names nobody — it reveals no part of the allowlist", async ({
    page,
  }) => {
    await submitRegistration(page, freshEmail("probe"));

    const message = await errorAlert(page).textContent();
    expect(message).toBe(REFUSAL);
    expect(message).not.toContain(E2E_ALLOWED_SIGNUP_EMAIL);
    expect(message).not.toContain("@");
  });

  test("the form stays usable, so a mistyped allowlisted address can be corrected", async ({
    page,
  }) => {
    // The real everyday case: the owner fat-fingers their own address, is
    // refused, and must be able to fix it in place rather than start over.
    await submitRegistration(page, `typo.${E2E_ALLOWED_SIGNUP_EMAIL}`);
    await expect(errorAlert(page)).toHaveText(REFUSAL);

    // Deliberately the no-navigation helper: `submitRegistration` would open
    // /register again, which is precisely the "start over" this test exists to
    // show is unnecessary.
    await fillAndSubmitRegisterForm(page, E2E_ALLOWED_SIGNUP_EMAIL);

    await expect(
      page.getByTestId("register-verification-notice"),
    ).toBeVisible();
    expect(await userRowExists(E2E_ALLOWED_SIGNUP_EMAIL)).toBe(true);
  });

  test("signing in is not gated by the allowlist", async ({ page }) => {
    // Registration is closed; the accounts that exist are not. A wrong-password
    // attempt must fail for its own reason, never with the sign-up refusal.
    await page.goto("/login");
    await page.getByLabel("Email").fill(freshEmail("signin"));
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(errorAlert(page)).toHaveText("Incorrect email or password.");
  });
});
