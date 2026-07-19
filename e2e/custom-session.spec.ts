import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { loadLearnerRelease } from "./helpers/learner-release";

/**
 * Phase 11 — custom session configuration (§4.4), hint system and editable
 * session defaults, end-to-end.
 */

/** The persisted review events (rating + hint fields via attempts). */
function idbReviewRatings(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("review_events")) return [];
      return await new Promise<string[]>((resolve, reject) => {
        const request = database
          .transaction("review_events", "readonly")
          .objectStore("review_events")
          .getAll();
        request.onsuccess = () =>
          resolve(
            (request.result as { rating: string }[]).map((row) => row.rating),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/** The persisted attempts' hint fields. */
function idbAttemptHints(
  page: Page,
): Promise<{ hintUsed: boolean; hintType: string | null }[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("study_attempts")) return [];
      return await new Promise<
        { hintUsed: boolean; hintType: string | null }[]
      >((resolve, reject) => {
        const request = database
          .transaction("study_attempts", "readonly")
          .objectStore("study_attempts")
          .getAll();
        request.onsuccess = () =>
          resolve(
            (
              request.result as {
                attempt?: { hintUsed?: boolean; hintType?: string | null };
              }[]
            ).map((row) => ({
              hintUsed: row.attempt?.hintUsed ?? false,
              hintType: row.attempt?.hintType ?? null,
            })),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/** Click the correct option for the current question. */
async function answerCorrectly(page: Page) {
  const session = page.getByTestId("mc-quiz-session");
  const entryId = await session.getAttribute("data-entry-id");
  const answerField = await session.getAttribute("data-answer-field");
  await page
    .locator(
      `[data-testid="mc-option"][data-answer-ref="entry:${entryId}:field:${answerField}"]`,
    )
    .click();
}

async function answerIncorrectly(page: Page) {
  const session = page.getByTestId("mc-quiz-session");
  const entryId = await session.getAttribute("data-entry-id");
  const answerField = await session.getAttribute("data-answer-field");
  await page
    .locator(
      `[data-testid="mc-option"]:not([data-answer-ref="entry:${entryId}:field:${answerField}"])`,
    )
    .first()
    .click();
}

test.describe("custom session — §4.4 filter matrix", () => {
  test("the demonstrate case: one bāb + maṣdar only + timed produces only matching questions", async ({
    page,
  }) => {
    const release = loadLearnerRelease();
    const targetBab = release.entries[0].bab;

    await page.goto("/study/custom");
    await expect(page.getByTestId("custom-setup")).toBeVisible();

    // Narrow: Ar→En, maṣdar only, one bāb, timed.
    await page.getByTestId("custom-direction-arabic_to_english").click();
    await page.getByTestId("custom-form-masdar").click();
    await page.getByTestId(`custom-bab-${targetBab}`).click();
    await page.getByTestId("custom-timed").click();
    await page.getByTestId("custom-start").click();

    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute("data-delivery", "timed");
    await expect(page.getByTestId("mc-timer")).toBeVisible();

    // Every question in the session matches EVERY active filter.
    for (let i = 0; i < 30; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      await expect(session).toHaveAttribute("data-source-field", "masdar");
      await expect(session).toHaveAttribute(
        "data-skill-type",
        "meaning_recognition",
      );
      const entryId = Number(await session.getAttribute("data-entry-id"));
      const entry = release.entries.find((e) => e.id === entryId);
      expect(entry?.bab).toBe(targetBab);
      expect(entry?.quiz_eligibility.masdar).toBe(true);
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
    }
    await expect(page.getByTestId("mc-results")).toBeVisible();
  });

  test("timed + test combine: countdown runs and feedback is withheld to the end", async ({
    page,
  }) => {
    await page.goto("/study/custom");
    await expect(page.getByTestId("custom-setup")).toBeVisible();
    // Keep it short so the whole session completes quickly.
    await page.getByTestId("custom-count").fill("2");
    await page.getByTestId("custom-timed").click();
    await page.getByTestId("custom-test-mode").click();
    await page.getByTestId("custom-start").click();

    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute("data-delivery", "timed_test");
    await expect(page.getByTestId("mc-timer")).toBeVisible();

    // Answer: NO inline feedback (test semantics), straight to question 2.
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-feedback")).toHaveCount(0);
    await expect(page.getByText("Question 2 of 2")).toBeVisible();
    await answerCorrectly(page);

    // Results reveal the withheld per-question outcomes.
    await expect(page.getByTestId("mc-results")).toBeVisible();
    await expect(page.getByTestId("mc-test-breakdown")).toBeVisible();
  });

  test("empty-result guard suggests loosening filters instead of erroring", async ({
    page,
  }) => {
    await page.goto("/study/custom");
    await expect(page.getByTestId("custom-setup")).toBeVisible();

    // A brand-new guest has no mastered components: mastered-only is empty.
    await page.getByTestId("custom-state-mastered").click();
    await page.getByTestId("custom-start").click();

    await expect(page.getByTestId("custom-empty-guard")).toBeVisible();
    await expect(page.getByTestId("loosen-suggestion").first()).toContainText(
      /progress state/i,
    );
    await expect(page.getByTestId("mc-quiz-session")).toHaveCount(0);

    // Loosening per the suggestion makes the same start succeed.
    await page.getByTestId("custom-state-mastered").click();
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
  });

  test("the bookmarks/lists placeholder is visible but disabled (Phase 14)", async ({
    page,
  }) => {
    await page.goto("/study/custom");
    const placeholder = page.getByTestId("custom-bookmarks-placeholder");
    await expect(placeholder).toBeVisible();
    await expect(placeholder.getByRole("button")).toBeDisabled();
  });

  test("the custom setup screen has no accessibility violations", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/study/custom");
    await expect(page.getByTestId("custom-setup")).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.target.join(" ")),
      })),
    ).toEqual([]);
  });
});

test.describe("hints — recording and FSRS rating mapping (§4.4)", () => {
  test("hinted correct ⇒ Hard; hinted incorrect ⇒ Again (persisted events)", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();

    // Question 1: take a hint, answer CORRECTLY → the scheduling event must
    // carry the reduced-credit rating Hard.
    await page.getByTestId("hint-first_letter").click();
    await expect(page.getByTestId("hint-display")).toBeVisible();
    await expect(session).toHaveAttribute("data-hint-used", "true");
    await answerCorrectly(page);
    await expect.poll(() => idbReviewRatings(page)).toEqual(["hard"]);
    await expect
      .poll(() => idbAttemptHints(page))
      .toEqual([{ hintUsed: true, hintType: "first_letter" }]);
    await page.getByTestId("mc-next").click();

    // Question 2: take a hint, answer INCORRECTLY → simply Again.
    await page.getByTestId("hint-first_letter").click();
    await expect(page.getByTestId("hint-display")).toBeVisible();
    await answerIncorrectly(page);
    await expect.poll(() => idbReviewRatings(page)).toEqual(["hard", "again"]);
    const hints = await idbAttemptHints(page);
    expect(hints).toHaveLength(2);
    expect(hints[1]).toEqual({ hintUsed: true, hintType: "first_letter" });

    // The results stat counts hinted attempts (visible after completing —
    // asserted implicitly by the feedback flow; the persisted evidence above
    // is the authoritative check).
  });

  test("an unhinted correct answer still rates Good (no hint leakage)", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect.poll(() => idbReviewRatings(page)).toEqual(["good"]);
  });
});

test.describe("session defaults — editable in settings (§4.4)", () => {
  test("changing questions/session in settings is honoured by the next quiz", async ({
    page,
  }) => {
    await page.goto("/settings");
    const input = page.getByTestId("study-default-questionCount");
    await expect(input).toBeEnabled();
    await input.fill("5");
    await page.getByTestId("study-defaults-save").click();
    await expect(page.getByText("Study defaults saved")).toBeVisible();

    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await expect(page.getByText("Question 1 of 5")).toBeVisible();
  });

  test("changing the option count changes the number of MC options", async ({
    page,
  }) => {
    await page.goto("/settings");
    const input = page.getByTestId("study-default-optionCount");
    await expect(input).toBeEnabled();
    await input.fill("6");
    await page.getByTestId("study-defaults-save").click();
    await expect(page.getByText("Study defaults saved")).toBeVisible();

    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await expect(page.getByTestId("mc-option")).toHaveCount(6);
  });
});
