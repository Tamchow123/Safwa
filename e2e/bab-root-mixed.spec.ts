import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { loadLearnerRelease } from "./helpers/learner-release";

/** The two unresolved-root entries (root/verb-type unverified in the source). */
const UNRESOLVED_ROOT_ENTRY_IDS = [369, 372];

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

/** The `promptField` + `skillTypeId` recorded on each persisted attempt. */
function idbAttemptPromptFields(
  page: Page,
): Promise<{ promptField: string | null; skillTypeId: string | null }[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("study_attempts")) return [];
      return await new Promise<
        { promptField: string | null; skillTypeId: string | null }[]
      >((resolve, reject) => {
        const request = database
          .transaction("study_attempts", "readonly")
          .objectStore("study_attempts")
          .getAll();
        request.onsuccess = () =>
          resolve(
            (
              request.result as {
                attempt?: { promptField?: string; skillTypeId?: string };
              }[]
            ).map((row) => ({
              promptField: row.attempt?.promptField ?? null,
              skillTypeId: row.attempt?.skillTypeId ?? null,
            })),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/**
 * The number of stored chain-ROOT review events (no parent) — each one marks a
 * component's first-ever scheduling review, i.e. a NEW-item introduction.
 */
function idbRootEventCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("review_events")) return 0;
      return await new Promise<number>((resolve, reject) => {
        const request = database
          .transaction("review_events", "readonly")
          .objectStore("review_events")
          .getAll();
        request.onsuccess = () =>
          resolve(
            (request.result as { parentEventId: string | null }[]).filter(
              (row) => row.parentEventId === null,
            ).length,
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/** The serialized ref of the current question's correct option. */
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

/** Complete a full immediate-feedback session by answering correctly. */
async function completeImmediateSession(
  page: Page,
  maxQuestions = 40,
  onQuestion?: () => Promise<void>,
) {
  for (let i = 0; i < maxQuestions; i++) {
    if (await page.getByTestId("mc-results").isVisible()) break;
    if (onQuestion) await onQuestion();
    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();
  }
}

test.describe("bāb quiz", () => {
  test("options are Arabic bāb pattern pairs — never numbering or transliteration", async ({
    page,
  }) => {
    await page.goto("/study/bab");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();

    await expect(session).toHaveAttribute(
      "data-skill-type",
      "bab_identification",
    );
    await expect(session).toHaveAttribute("data-answer-field", "bab");
    // Default prompt form is the māḍī.
    await expect(session).toHaveAttribute("data-prompt-field", "madi");
    await expect(page.getByTestId("mc-prompt-caption")).toHaveText(
      "Choose the bāb",
    );

    // Every option, across several questions, is one of the six bāb pairs
    // from the release (compared programmatically — never hand-typed Arabic),
    // contains Arabic script, and never digits, Latin letters or "Form I–VI".
    const babPairs = new Set(
      loadLearnerRelease().entries.map((entry) => entry.bab_arabic),
    );
    for (let i = 0; i < 3; i++) {
      const texts = await page.getByTestId("mc-option").allInnerTexts();
      expect(texts).toHaveLength(4);
      for (const text of texts) {
        const trimmed = text.trim();
        expect(babPairs.has(trimmed)).toBe(true);
        expect(trimmed).toMatch(/[؀-ۿ]/);
        expect(trimmed).not.toMatch(/[0-9A-Za-z]/);
      }
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
      await expect(session).toBeVisible();
    }
  });

  test("a configured muḍāriʿ prompt form is honoured and recorded on the attempt", async ({
    page,
  }) => {
    await page.goto("/study/bab");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();

    await page.getByTestId("prompt-form-select").selectOption("mudari");
    await expect(session).toHaveAttribute("data-prompt-field", "mudari");

    // The prompted form is eligible for the shown entry (hard rule 2).
    const entryId = Number(await session.getAttribute("data-entry-id"));
    const entry = loadLearnerRelease().entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`entry ${entryId} not in release`);
    expect(entry.quiz_eligibility.mudari).toBe(true);

    await answerCorrectly(page);
    // The persisted attempt records the prompt form and the bāb skill.
    await expect
      .poll(() => idbAttemptPromptFields(page))
      .toEqual([{ promptField: "mudari", skillTypeId: "bab_identification" }]);
  });

  test("the bāb quiz route has no accessibility violations (initial + feedback)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/study/bab");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    const initial = await new AxeBuilder({ page }).analyze();
    expect(
      initial.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.target.join(" ")),
      })),
    ).toEqual([]);

    await answerCorrectly(page);
    await expect(page.getByTestId("mc-feedback")).toBeVisible();
    // The just-enabled Undo button animates opacity (transition-all on the
    // shared button). Scan the steady state — a mid-transition frame reads as
    // a spurious contrast violation.
    await expect(page.getByTestId("undo")).toHaveCSS("opacity", "1");
    const afterAnswer = await new AxeBuilder({ page }).analyze();
    expect(afterAnswer.violations).toEqual([]);
  });
});

test.describe("root quiz", () => {
  test("excludes entries 369/372 from targets and options across a full session", async ({
    page,
  }) => {
    await page.goto("/study/root");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute(
      "data-skill-type",
      "root_identification",
    );
    await expect(session).toHaveAttribute("data-answer-field", "root");

    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      // The quizzed entry is never an unresolved-root entry, and its root
      // eligibility is true in the release.
      const entryId = Number(await session.getAttribute("data-entry-id"));
      expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(entryId);
      const entry = loadLearnerRelease().entries.find((e) => e.id === entryId);
      expect(entry?.quiz_eligibility.root).toBe(true);
      // No option — target or distractor — references 369/372 either.
      const refs = await page
        .getByTestId("mc-option")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-answer-ref")),
        );
      expect(refs).toHaveLength(4);
      for (const ref of refs) {
        expect(ref).toMatch(/:field:root$/);
        const optionEntryId = Number(/^entry:(\d+):/.exec(ref!)![1]);
        expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(optionEntryId);
      }
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
    }
    await expect(page.getByTestId("mc-results")).toBeVisible();
    // Scheduling events persisted for the graded first attempts.
    expect(await idbCount(page, "review_events")).toBeGreaterThan(0);
  });
});

test.describe("mixed revision — Start studying", () => {
  test("a brand-new guest gets a sensible zero-config session in one tap from Study", async ({
    page,
  }) => {
    await page.goto("/study");
    await page.getByTestId("start-studying").click();

    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    // A brand-new guest has nothing due and no weak items: the plan is the
    // daily new-item target (10), with zero configuration.
    await expect(page.getByText("Question 1 of 10")).toBeVisible();

    await completeImmediateSession(page);
    await expect(page.getByTestId("mc-results")).toBeVisible();
    // Every first attempt persisted an attempt and a scheduling event.
    expect(await idbCount(page, "study_attempts")).toBe(10);
    expect(await idbCount(page, "review_events")).toBe(10);
  });

  test("repeated same-day sessions share ONE daily allowance (10 new/day, 20 reviews/day)", async ({
    page,
  }) => {
    // Session 1: the 10 new items of today's allowance (all graded).
    await page.goto("/study/mixed");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await expect(page.getByText("Question 1 of 10")).toBeVisible();
    await completeImmediateSession(page);
    await expect(page.getByTestId("mc-results")).toBeVisible();
    expect(await idbRootEventCount(page)).toBe(10);

    // Session 2: the new-item budget is SPENT for today, so no further new
    // components are introduced — only the 10 already-seen components return
    // as reviews (within the 20-review budget).
    await page.getByTestId("study-again").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await expect(page.getByText("Question 1 of 10")).toBeVisible();
    await completeImmediateSession(page);
    await expect(page.getByTestId("mc-results")).toBeVisible();
    // Still exactly 10 chain-root events: session 2 introduced NOTHING new.
    expect(await idbRootEventCount(page)).toBe(10);
    expect(await idbCount(page, "study_attempts")).toBe(20);

    // Session 3: the remaining 10 of the 20-review budget.
    await page.getByTestId("study-again").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await expect(page.getByText("Question 1 of 10")).toBeVisible();
    await completeImmediateSession(page);
    await expect(page.getByTestId("mc-results")).toBeVisible();
    expect(await idbRootEventCount(page)).toBe(10);

    // Session 4: both budgets exhausted — the learner has reached today's
    // targets and gets the empty state, never another daily allowance.
    await page.getByTestId("study-again").click();
    await expect(page.getByTestId("mc-empty")).toBeVisible();
    await expect(page.getByTestId("mc-empty")).toContainText(
      /today's targets/i,
    );
  });

  test("due reviews come first, and 369/372 never surface as root or verb-type material", async ({
    page,
  }) => {
    // Seed a returning learner whose root + verb-type components of a real
    // eligible entry are DUE (cards due in the past), then start a mixed
    // session: the due reviews must precede the new items, and every
    // root/verb-type question must exclude the unresolved entries 369/372 —
    // target and options alike.
    const eligibleEntry = loadLearnerRelease().entries.find(
      (entry) =>
        entry.quiz_eligibility.root && entry.quiz_eligibility.verb_type,
    );
    if (!eligibleEntry) throw new Error("no root+verb_type eligible entry");

    // Load the mixed route once so the app creates the database and its
    // learner-state stores (the study landing alone never opens IndexedDB),
    // then seed and reload for a fresh session over the seeded state.
    await page.goto("/study/mixed");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await page.evaluate(
      async ({ entryId }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("safwa-content");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const dayMs = 24 * 60 * 60 * 1000;
          const card = (dueAtMs: number) => ({
            stability: 1,
            difficulty: 5,
            dueAtMs,
            state: "review",
            reps: 1,
            lapses: 0,
            scheduledDays: 1,
            learningSteps: 0,
            lastReviewAtMs: dueAtMs - dayMs,
          });
          const rows = [
            {
              componentKey: `entry:${entryId}:skill:root_identification`,
              entryId,
              fsrs: card(Date.now() - 2 * dayMs),
              learnerState: "learning",
              revision: 1,
            },
            {
              componentKey: `entry:${entryId}:skill:verb_type_identification`,
              entryId,
              fsrs: card(Date.now() - dayMs),
              learnerState: "learning",
              revision: 1,
            },
          ];
          await new Promise<void>((resolve, reject) => {
            const tx = database.transaction("study_components", "readwrite");
            const store = tx.objectStore("study_components");
            for (const row of rows) store.put(row);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } finally {
          database.close();
        }
      },
      { entryId: eligibleEntry.id },
    );

    await page.reload();
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    // 2 due reviews + 10 new items.
    await expect(page.getByText("Question 1 of 12")).toBeVisible();

    // Due-first ordering: the two seeded due components open the session,
    // most overdue first (root, then verb type).
    await expect(session).toHaveAttribute("data-answer-field", "root");
    await expect(session).toHaveAttribute(
      "data-entry-id",
      String(eligibleEntry.id),
    );

    const seenGuardedFields = new Set<string>();
    const guardUnresolvedEntries = async () => {
      const answerField = await session.getAttribute("data-answer-field");
      if (answerField !== "root" && answerField !== "verb_type") return;
      seenGuardedFields.add(answerField);
      const entryId = Number(await session.getAttribute("data-entry-id"));
      expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(entryId);
      const refs = await page
        .getByTestId("mc-option")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-answer-ref")),
        );
      for (const ref of refs) {
        const optionEntryId = Number(/^entry:(\d+):/.exec(ref!)![1]);
        expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(optionEntryId);
      }
    };
    await completeImmediateSession(page, 40, guardUnresolvedEntries);
    await expect(page.getByTestId("mc-results")).toBeVisible();
    // Non-vacuity: the seeded due components guarantee both skills appeared.
    expect(seenGuardedFields.has("root")).toBe(true);
    expect(seenGuardedFields.has("verb_type")).toBe(true);
  });

  test("the mixed session route has no accessibility violations", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/study/mixed");
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
});
