/**
 * The register / verify / sign-in / sign-out flows, driven through the real UI
 * and the real outbox.
 *
 * Extracted from `auth.spec.ts` in Phase 17 because the guest→account merge
 * suite needs the same journeys and they must not drift: a merge spec that
 * signs in slightly differently from the auth spec is a merge spec that can
 * pass while the thing learners actually do is broken.
 *
 * These follow REAL links from the local email outbox — never a fabricated
 * token — which is why every spec that imports them must also disable trace
 * capture for its file (`test.use({ trace: "off" })`). A CI retry would
 * otherwise bundle a token-bearing URL into an uploaded trace.
 */
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

import { extractUrlFromMessage, waitForOutboxMessage } from "./email-outbox";

export const E2E_PASSWORD = "correct-horse-battery-staple";

/**
 * How long {@link declineMergePrompt} waits for the merge prompt AFTER the page
 * has gone quiet.
 *
 * Small on purpose. The expensive part of the wait — the session request and
 * the route compile — is covered by waiting for network idle first, so this
 * only has to cover the render that follows. A generous blind timeout here was
 * the first attempt and it was worse than useless: three of them in one spec
 * consumed the entire 30s test budget and failed the assertions afterwards.
 */
const MERGE_PROMPT_RENDER_MS = 2_000;

/** Bound on waiting for the page to go quiet — a cold dev-server compile. */
const MERGE_PROMPT_SETTLE_MS = 15_000;

/** A never-before-used address, so a spec never inherits another's account. */
export function freshEmail(prefix: string): string {
  return `e2e.${prefix}.${randomUUID()}@example.test`;
}

/**
 * Fill and submit the register form ON THE PAGE ALREADY OPEN — no navigation,
 * and no assertion about the outcome.
 *
 * The no-navigation part is the reason this exists separately from
 * {@link submitRegistration}: the sign-up-allowlist spec (Phase 18) has to
 * prove a learner can correct a refused address IN PLACE, and a `goto` would
 * quietly turn that into "start over", which is the thing it is testing did
 * not happen.
 *
 * This is now the only place in `e2e/` that knows the register form's
 * locators — `auth-disabled.spec.ts` and `guest-merge.spec.ts` were each
 * carrying their own copy and were migrated onto this ladder when it was
 * extracted. If you add a field to the form, this function is the one to
 * change.
 */
export async function fillAndSubmitRegisterForm(
  page: Page,
  email: string,
  password = E2E_PASSWORD,
  name = "E2E Learner",
): Promise<void> {
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

/**
 * Open /register and submit it, asserting NOTHING about the outcome.
 *
 * Split out from {@link registerOnly} for the sign-up-allowlist spec, which
 * submits registrations that are meant to be refused — so it needs the same
 * form-driving as every other spec without the success assertion.
 */
export async function submitRegistration(
  page: Page,
  email: string,
  password = E2E_PASSWORD,
  name = "E2E Learner",
): Promise<void> {
  await page.goto("/register");
  await fillAndSubmitRegisterForm(page, email, password, name);
}

/** Submit the register form only — does not follow the verification link. */
export async function registerOnly(
  page: Page,
  email: string,
  password = E2E_PASSWORD,
  name = "E2E Learner",
): Promise<void> {
  await submitRegistration(page, email, password, name);
  await expect(page.getByTestId("register-verification-notice")).toBeVisible();
}

/** Register, read the real verification email from the local outbox, follow it. */
export async function registerAndVerify(
  page: Page,
  email: string,
  password = E2E_PASSWORD,
  name = "E2E Learner",
): Promise<void> {
  await registerOnly(page, email, password, name);
  const message = await waitForOutboxMessage(email, "verify-email");
  await page.goto(extractUrlFromMessage(message));
  await expect(page.getByTestId("verify-email-success")).toBeVisible();
}

export async function login(
  page: Page,
  email: string,
  password = E2E_PASSWORD,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Wait for the sign-in call + redirect to actually complete before
  // returning — otherwise a caller's immediate page.goto() to a session-gated
  // route can race the still-in-flight request.
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Answer "Not now" to the guest→account merge prompt, if it is showing.
 *
 * Phase 17 puts a MODAL in front of a learner who signs in on a device that
 * still holds guest data — which is most of the auth suite, since those specs
 * seed or produce local rows before registering. A modal blocks every click
 * behind it, so a spec that is not about the merge has to answer the question
 * before it can carry on, exactly as a person would.
 *
 * Declining is the right answer for those specs: it is non-destructive, sends
 * nothing, and leaves the guest's rows alone (phases-17.md §9.1) — so a spec
 * asserting that login does NOT upload guest data still asserts precisely that.
 * Tests that are ABOUT the merge must never call this; they answer the prompt
 * themselves and assert on what it says.
 */
export async function declineMergePrompt(page: Page): Promise<void> {
  const dialog = page.getByTestId("guest-merge-dialog");
  // A WAIT, not an `isVisible()` snapshot: the prompt appears only after the
  // client has read the session and counted what is on the device, so asking
  // the instant sign-in returns is told "not yet" — and then the modal opens
  // behind the spec's back and blocks everything after it.
  //
  // Network idle is what separates "has not appeared yet" from "is not going
  // to": the session request is the slow part, and once it and the page's other
  // traffic are done, only a render remains.
  try {
    await page.waitForLoadState("networkidle", {
      timeout: MERGE_PROMPT_SETTLE_MS,
    });
  } catch {
    // Never went quiet (a poll, a retry). Fall through and look anyway.
  }
  try {
    await dialog.waitFor({ state: "visible", timeout: MERGE_PROMPT_RENDER_MS });
  } catch {
    // It never came — this device had nothing to merge. Nothing to answer.
    return;
  }
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toHaveCount(0);
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}
