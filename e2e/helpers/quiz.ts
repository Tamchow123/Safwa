/**
 * Answering a multiple-choice question, the one way every spec does it.
 *
 * Extracted in Phase 17 for the same reason the auth flows were: four specs had
 * grown four near-copies, and they had already diverged — the newest one waited
 * for an option to be ENABLED before reading the question's identity and the
 * older ones did not. That difference is not cosmetic. Answering disables every
 * option, and the previous question's buttons stay in the DOM for a beat after
 * "Next", so reading `data-entry-id` too early reads one question's identity and
 * then clicks another question's dead button. The robust version is the one kept
 * here; a spec that quietly gets the fragile version is a spec that fails on a
 * slow machine and nowhere else.
 */
import { expect, type Page } from "@playwright/test";

/**
 * Wait until a question is genuinely ready to be answered, and return the
 * answer-ref of its CORRECT option.
 */
export async function readyQuestion(page: Page): Promise<string> {
  const session = page.getByTestId("mc-quiz-session");
  await expect(session).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("mc-option").first()).toBeEnabled({
    timeout: 20_000,
  });
  const entryId = await session.getAttribute("data-entry-id");
  const answerField = await session.getAttribute("data-answer-field");
  return `entry:${entryId}:field:${answerField}`;
}

/** Click the correct option for the current MC question. */
export async function answerCorrectly(page: Page): Promise<void> {
  const correct = await readyQuestion(page);
  await page
    .locator(`[data-testid="mc-option"][data-answer-ref="${correct}"]`)
    .click();
}

/**
 * Click a WRONG option, so the history carries a lapse and the reinforcement
 * the scheduler produces from it.
 */
export async function answerIncorrectly(page: Page): Promise<void> {
  const correct = await readyQuestion(page);
  await page
    .locator(`[data-testid="mc-option"]:not([data-answer-ref="${correct}"])`)
    .first()
    .click();
}
