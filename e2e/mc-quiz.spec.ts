import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { loadLearnerRelease } from "./helpers/learner-release";

/** Count rows in an app IndexedDB object store, independent of app code. */
function idbCount(page: Page, store: string): Promise<number> {
  return page.evaluate(async (store) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains(store)) return 0;
      return await new Promise<number>((resolve, reject) => {
        const request = database
          .transaction(store, "readonly")
          .objectStore(store)
          .count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, store);
}

/** All review-event ratings currently stored. */
function idbRatings(page: Page): Promise<string[]> {
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
            (request.result as { rating?: string }[]).map(
              (row) => row.rating ?? "?",
            ),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/** The `sourceField` recorded on each persisted study attempt. */
function idbAttemptSourceFields(page: Page): Promise<(string | null)[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("study_attempts")) return [];
      return await new Promise<(string | null)[]>((resolve, reject) => {
        const request = database
          .transaction("study_attempts", "readonly")
          .objectStore("study_attempts")
          .getAll();
        request.onsuccess = () =>
          resolve(
            (
              request.result as { attempt?: { sourceField?: string | null } }[]
            ).map((row) => row.attempt?.sourceField ?? null),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/** The serialized ref of the current question's correct option — always the
 * prompt entry's answer field (distractors are drawn from OTHER entries). */
async function correctOptionRef(page: Page): Promise<string> {
  const session = page.getByTestId("mc-quiz-session");
  const entryId = await session.getAttribute("data-entry-id");
  const answerField = await session.getAttribute("data-answer-field");
  return `entry:${entryId}:field:${answerField}`;
}

/** Click the correct option for the current question. */
async function answerCorrectly(page: Page) {
  const ref = await correctOptionRef(page);
  await page
    .locator(`[data-testid="mc-option"][data-answer-ref="${ref}"]`)
    .click();
}

/** Complete a full session by answering every question correctly (advancing
 * past feedback in immediate mode) until the results screen appears. */
async function completeImmediateSession(page: Page) {
  for (let i = 0; i < 40; i++) {
    if (await page.getByTestId("mc-results").isVisible()) break;
    await answerCorrectly(page);
    // Feedback appears; advance to the next question (or the results screen).
    // The click auto-waits for Next to be visible and enabled.
    await page.getByTestId("mc-next").click();
  }
}

test.describe("multiple-choice quizzes", () => {
  test("a guest reaches the first question in 2 taps from landing", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/");
    const nav = isMobile
      ? page.getByTestId("mobile-nav")
      : page.getByTestId("app-sidebar");

    await nav.getByRole("link", { name: "Study" }).click();
    await page.getByTestId("start-mc-quiz").click();

    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await expect(page.getByText(/Question 1 of/)).toBeVisible();
    // §4.5: exactly four options.
    await expect(page.getByTestId("mc-option")).toHaveCount(4);
  });

  test("completes an Arabic→English session and persists scheduling events", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    // Default direction is Ar→En: the answer is the English meaning.
    await expect(session).toHaveAttribute("data-answer-field", "meaning");

    await completeImmediateSession(page);

    await expect(page.getByTestId("mc-results")).toBeVisible();
    // Every graded first attempt persisted an attempt and a scheduling event.
    const attempts = await idbCount(page, "study_attempts");
    const events = await idbCount(page, "review_events");
    expect(attempts).toBeGreaterThan(0);
    expect(events).toBe(attempts);
    // All answered correctly → every event is a Good rating.
    expect(await idbRatings(page)).toEqual(
      Array.from({ length: events }, () => "good"),
    );
  });

  test("completes an English→Arabic session (meaning prompt, Arabic options)", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    await page.getByRole("button", { name: "English → Arabic" }).click();
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toHaveAttribute("data-prompt-field", "meaning");
    await expect(session).not.toHaveAttribute("data-answer-field", "meaning");

    await completeImmediateSession(page);
    await expect(page.getByTestId("mc-results")).toBeVisible();
    expect(await idbCount(page, "review_events")).toBeGreaterThan(0);
  });

  /**
   * Independent expectations per source form — hard-coded here (NOT imported
   * from the app's shared metadata map) so a swap or typo in that map is
   * caught. These are Latin transliteration labels, not dataset Arabic, so
   * hard rule 3 does not apply.
   */
  const EXPECTED_FORM_NAMES: Record<string, string> = {
    madi: "māḍī",
    mudari: "muḍāriʿ",
    masdar: "maṣdar",
    ism_fail: "ism al-fāʿil",
    amr: "amr",
    nahi: "nahī",
  };
  const EXPECTED_FORM_LABELS: Record<string, string> = {
    madi: "Past (māḍī)",
    mudari: "Present (muḍāriʿ)",
    masdar: "Verbal noun (maṣdar)",
    ism_fail: "Active participle (ism al-fāʿil)",
    amr: "Command (amr)",
    nahi: "Prohibition (nahī)",
  };

  /**
   * Answer the current question correctly and assert the base-meaning
   * semantics for its direction: Ar→En keeps the form hidden until the
   * feedback; En→Ar names the requested form BEFORE answering. Both show the
   * base meaning labelled as such (never as an exact form translation) plus
   * the exact form label in the feedback.
   */
  async function assertBaseMeaningSemantics(
    page: Page,
    direction: "recognition" | "recall",
  ) {
    const session = page.getByTestId("mc-quiz-session");
    const sourceField = await session.getAttribute("data-source-field");
    expect(sourceField, "source field is present").toBeTruthy();
    const expectedName = EXPECTED_FORM_NAMES[sourceField!];
    const expectedLabel = EXPECTED_FORM_LABELS[sourceField!];
    expect(expectedName, `a known form name for ${sourceField}`).toBeTruthy();

    // No feedback yet in either direction.
    await expect(page.getByTestId("mc-form-reveal")).toHaveCount(0);
    if (direction === "recognition") {
      // Ar→En: the quizzed form is NOT named before answering (§4.5); the
      // options are base meanings.
      await expect(page.getByTestId("mc-prompt-caption")).toHaveText(
        "Choose the base meaning",
      );
      await expect(page.getByTestId("mc-base-meaning-label")).toHaveCount(0);
    } else {
      // En→Ar: the requested form IS named before answering, and the prompt
      // gloss is visibly labelled as a base meaning.
      await expect(page.getByTestId("mc-prompt-caption")).toHaveText(
        `Choose the ${expectedName} form`,
      );
      await expect(page.getByTestId("mc-base-meaning-label")).toHaveText(
        "Base meaning",
      );
    }

    // The quizzed source form is eligible for the prompt entry (hard rule 2).
    const entryId = Number(await session.getAttribute("data-entry-id"));
    const entry = loadLearnerRelease().entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`entry ${entryId} not in release`);
    expect(
      entry.quiz_eligibility[
        sourceField as keyof typeof entry.quiz_eligibility
      ],
    ).toBe(true);

    await answerCorrectly(page);
    // Feedback: the entry's base meaning labelled as such, plus the exact
    // form label from the independent expectation for THIS source form.
    await expect(page.getByTestId("mc-base-meaning")).toHaveText(
      `Base meaning: ${entry.meaning}`,
    );
    const reveal = page.getByTestId("mc-form-reveal");
    await expect(reveal).toBeVisible();
    await expect(reveal).toHaveText(`Form: ${expectedLabel}`);
    await expect(page.getByTestId("mc-feedback-outcome")).toHaveAttribute(
      "data-correct",
      "true",
    );
  }

  test("Arabic→English hides the form until feedback, then names it with the base meaning", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    // Sample several successive questions so more than one source form is checked.
    for (let i = 0; i < 4; i++) {
      await assertBaseMeaningSemantics(page, "recognition");
      await page.getByTestId("mc-next").click();
      await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    }
  });

  test("English→Arabic names the requested form before answering, per question", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await page.getByRole("button", { name: "English → Arabic" }).click();
    await expect(page.getByTestId("mc-quiz-session")).toHaveAttribute(
      "data-prompt-field",
      "meaning",
    );
    for (let i = 0; i < 4; i++) {
      await assertBaseMeaningSemantics(page, "recall");
      await page.getByTestId("mc-next").click();
      await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    }
  });

  test("a selected English→Arabic form is named before answering, constrains options and is recorded", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await page.getByRole("button", { name: "English → Arabic" }).click();
    await page.getByLabel("Form").selectOption("mudari");

    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toHaveAttribute("data-source-field", "mudari");
    // 1. The requested form label is visible BEFORE answering.
    await expect(page.getByTestId("mc-prompt-caption")).toHaveText(
      `Choose the ${EXPECTED_FORM_NAMES.mudari} form`,
    );
    await expect(page.getByTestId("mc-form-reveal")).toHaveCount(0);
    // 4. The prompt gloss is visibly labelled as a base meaning and is the
    // entry's verbatim release meaning.
    await expect(page.getByTestId("mc-base-meaning-label")).toHaveText(
      "Base meaning",
    );
    const entryId = Number(await session.getAttribute("data-entry-id"));
    const entry = loadLearnerRelease().entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`entry ${entryId} not in release`);
    await expect(session).toContainText(entry.meaning);
    // 2. All four options use exactly that source field.
    const options = page.getByTestId("mc-option");
    await expect(options).toHaveCount(4);
    const refs = await options.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-answer-ref")),
    );
    for (const ref of refs) {
      expect(ref).toMatch(/:field:mudari$/);
    }
    // 3. The persisted attempt records that source field.
    await answerCorrectly(page);
    await expect.poll(() => idbAttemptSourceFields(page)).toEqual(["mudari"]);
  });

  test("test mode withholds feedback until the results screen", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    await page.getByTestId("mc-delivery-select").selectOption("test");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    // Answer several questions; per-question feedback must never appear inline.
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      // Capture the position BEFORE answering: the click resolves when the
      // React handler dispatches, not when the async IndexedDB write lands, so
      // the loop must wait for the persisted answer to actually advance the
      // question (or finish the session) — never a wall-clock sleep.
      const position = await page
        .getByText(/Question \d+ of \d+/)
        .textContent();
      await answerCorrectly(page);
      await expect(page.getByTestId("mc-feedback")).toHaveCount(0);
      await expect(async () => {
        if (await page.getByTestId("mc-results").isVisible()) return;
        const current = await page
          .getByText(/Question \d+ of \d+/)
          .textContent();
        expect(current).not.toBe(position);
      }).toPass();
    }

    await expect(page.getByTestId("mc-results")).toBeVisible();
    // Per-question outcomes are revealed only now.
    const outcomes = page.getByTestId("mc-result-outcome");
    const outcomeCount = await outcomes.count();
    expect(outcomeCount).toBeGreaterThan(0);
    // Test mode still reveals the quizzed form (per row) — it withholds
    // correctness, not the form identity (§4.3/§4.4). This screen is the ONLY
    // feedback in test mode, so every row labels the gloss as a base meaning
    // and names the form with its label.
    expect(await page.getByTestId("mc-result-form").count()).toBe(outcomeCount);
    for (let i = 0; i < outcomeCount; i++) {
      const row = outcomes.nth(i);
      await expect(row).toContainText("Base meaning: ");
      const sourceField = await row.getAttribute("data-source-field");
      const label = EXPECTED_FORM_LABELS[sourceField ?? ""];
      expect(label, `a known form label for ${sourceField}`).toBeTruthy();
      await expect(row.getByTestId("mc-result-form")).toContainText(
        `Form: ${label}`,
      );
    }
  });

  test("timed-mode expiry counts the question as incorrect", async ({
    page,
  }) => {
    // Control the clock so the 20s per-question limit can lapse instantly.
    await page.clock.install();
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    await page.getByTestId("mc-delivery-select").selectOption("timed");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute("data-delivery", "timed");
    // The countdown is shown.
    await expect(page.getByTestId("mc-timer")).toBeVisible();

    // Let the per-question limit lapse without answering.
    await page.clock.fastForward(21000);

    // The lapse is recorded as an incorrect first attempt → an Again event.
    await expect(page.getByTestId("mc-feedback-outcome")).toHaveAttribute(
      "data-correct",
      "false",
    );
    await expect(page.getByTestId("mc-feedback")).toContainText(/time's up/i);
    await expect.poll(() => idbRatings(page)).toEqual(["again"]);
  });

  test("undo reverses exactly the last graded question, once", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await expect(page.getByTestId("undo")).toBeDisabled();

    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();
    await expect(page.getByText(/Question 2 of/)).toBeVisible();
    await expect.poll(() => idbCount(page, "review_events")).toBe(1);

    await page.getByTestId("undo").click();
    await expect(page.getByText(/Question 1 of/)).toBeVisible();
    await expect.poll(() => idbCount(page, "study_attempts")).toBe(0);
    await expect.poll(() => idbCount(page, "review_events")).toBe(0);
    await expect(page.getByTestId("undo")).toBeDisabled();
  });

  test("a keyboard-only journey answers questions and advances", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    // A fresh question focuses its first option (the keyboard entry point).
    await expect(page.getByTestId("mc-option").first()).toBeFocused();

    for (let i = 0; i < 3; i++) {
      const ref = await correctOptionRef(page);
      const option = page.locator(
        `[data-testid="mc-option"][data-answer-ref="${ref}"]`,
      );
      // Activate the option with the keyboard (Enter on the focused button).
      await option.focus();
      await page.keyboard.press("Enter");

      await expect(page.getByTestId("mc-feedback")).toBeVisible();
      // Feedback moves focus to Next; advance it by keyboard.
      await expect(page.getByTestId("mc-next")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
      // The next question again focuses its first option.
      await expect(page.getByTestId("mc-option").first()).toBeFocused();
    }
  });

  test("options never show duplicate visible choices (§4.5)", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    // Inspect several successive questions' option sets.
    for (let i = 0; i < 5; i++) {
      const texts = await page.getByTestId("mc-option").allInnerTexts();
      expect(texts).toHaveLength(4);
      const normalised = texts.map((t) => t.trim());
      expect(new Set(normalised).size).toBe(4);
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
      await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    }
  });

  test("the multiple-choice route has no accessibility violations", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.target.join(" ")),
      })),
    ).toEqual([]);
  });

  test("axe scan after answering (feedback state) is clean", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-feedback")).toBeVisible();
    // The just-enabled Undo button animates opacity (transition-all on the
    // shared button); a mid-transition frame reads as a spurious contrast
    // violation. Scan the steady state (same guard as bab-root-mixed.spec).
    await expect(page.getByTestId("undo")).toHaveCSS("opacity", "1");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
