import { chromium, type Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { expectNoSeriousViolations } from "./helpers/axe";
import { idbAll, idbSeed, seedBookmark, seedList } from "./helpers/idb";
import {
  duplicateMadiPair,
  loadLearnerRelease,
  uniqueMeaningEntry,
} from "./helpers/learner-release";
import type { LearnerEntry } from "../modules/content/schema";

/**
 * Phase 14 — bookmarks & custom lists, end-to-end (docs/phases/phases-14.md
 * §31). Every entry/bāb/list membership value below comes from the loaded
 * learner release or a deterministic local seed — never hand-typed Arabic.
 */

async function waitForLibrary(page: Page) {
  await expect(page.getByTestId("library-result-count")).toHaveText(
    /entries|matched/,
    { timeout: 15_000 },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// U+201C/U+201D (curly quotes), built from codepoints rather than typed
// literally — the aria-labels below are constructed with these exact
// glyphs (see components/collections/{add-entries-dialog,
// collection-entry-row}.tsx).
const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);

/** Matches AddEntriesDialog's exact "Add “X” to this list" aria-label. */
function addToListLabel(meaning: string): RegExp {
  return new RegExp(
    `^Add ${LEFT_QUOTE}${escapeRegExp(meaning)}${RIGHT_QUOTE} to this list$`,
  );
}

/** Matches AddEntriesDialog's exact "“X” is already in this list" aria-label. */
function alreadyInListLabel(meaning: string): RegExp {
  return new RegExp(
    `^${LEFT_QUOTE}${escapeRegExp(meaning)}${RIGHT_QUOTE} is already in this list$`,
  );
}

/** Matches CollectionEntryRow's exact "Remove “X” from this list" aria-label. */
function removeFromListLabel(meaning: string): RegExp {
  return new RegExp(
    `^Remove ${LEFT_QUOTE}${escapeRegExp(meaning)}${RIGHT_QUOTE} from this list$`,
  );
}

/** Two bābs each with at least two real entries (union/intersection tests). */
function twoBabsWithTwoEntries(): {
  babA: string;
  entriesA: LearnerEntry[];
  babB: string;
  entriesB: LearnerEntry[];
} {
  const byBab = new Map<string, LearnerEntry[]>();
  for (const entry of loadLearnerRelease().entries) {
    byBab.set(entry.bab, [...(byBab.get(entry.bab) ?? []), entry]);
  }
  const eligible = [...byBab.entries()].filter(
    ([, group]) => group.length >= 2,
  );
  if (eligible.length < 2) {
    throw new Error("need at least two bābs with >=2 entries each");
  }
  const [[babA, entriesA], [babB, entriesB]] = eligible;
  return {
    babA,
    entriesA: entriesA.slice(0, 2),
    babB,
    entriesB: entriesB.slice(0, 2),
  };
}

/** Click the correct MC option for the current custom-session question. */
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

/** Click a wrong MC option for the current custom-session question. */
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

/** No horizontal overflow: the page must not scroll sideways (§31.14). */
async function expectNoHorizontalOverflow(page: Page, width: number) {
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

test.describe("31.1 — bookmark from Library", () => {
  test("bookmarking a Library entry updates state without navigating, survives reload, and appears on Saved Vocabulary", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    await page.goto("/library");
    await waitForLibrary(page);
    await page.getByLabel("Search vocabulary").fill(target.meaning);
    await expect(page.locator(`[data-entry-id="${target.id}"]`)).toBeVisible();

    const saveButton = page.getByRole("button", {
      name: `Save "${target.meaning}"`,
    });
    await saveButton.click();
    const removeButton = page.getByRole("button", {
      name: `Remove "${target.meaning}" from bookmarks`,
    });
    await expect(removeButton).toHaveAttribute("data-bookmarked", "true");
    await expect(removeButton).toHaveAttribute("aria-pressed", "true");
    // No navigation occurred — still on Library, still filtered.
    await expect(page).toHaveURL(/\/library(\?|$)/);

    await page.reload();
    await page.getByLabel("Search vocabulary").fill(target.meaning);
    await expect(
      page.getByRole("button", {
        name: `Remove "${target.meaning}" from bookmarks`,
      }),
    ).toHaveAttribute("data-bookmarked", "true");

    await page.goto("/library/saved");
    await expect(
      page.getByRole("link", { name: target.meaning }),
    ).toBeVisible();
  });
});

test.describe("31.2 — bookmark from detail", () => {
  test("bookmarking from detail reflects on the Library card; removing it updates Saved Vocabulary", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    await page.goto(`/library/${target.id}`);
    await expect(page.getByTestId("entry-detail")).toBeVisible();
    await page
      .getByRole("button", { name: `Save "${target.meaning}"` })
      .click();
    await expect(
      page.getByRole("button", {
        name: `Remove "${target.meaning}" from bookmarks`,
      }),
    ).toHaveAttribute("data-bookmarked", "true");

    await page.goto("/library");
    await waitForLibrary(page);
    await page.getByLabel("Search vocabulary").fill(target.meaning);
    const libraryToggle = page.getByRole("button", {
      name: `Remove "${target.meaning}" from bookmarks`,
    });
    await expect(libraryToggle).toHaveAttribute("data-bookmarked", "true");

    await libraryToggle.click();
    await expect(
      page.getByRole("button", { name: `Save "${target.meaning}"` }),
    ).toHaveAttribute("data-bookmarked", "false");

    await page.goto("/library/saved");
    await expect(page.getByText(target.meaning)).toHaveCount(0);
  });
});

test.describe("31.3 — protected duplicate entries", () => {
  test("bookmarking both entries in a protected duplicate-madi group keeps them distinct", async ({
    page,
  }) => {
    // Duplicate-madi pairs can share the same English meaning too, so every
    // locator below is scoped by entry id / href — never by meaning text.
    const [a, b] = duplicateMadiPair();
    await page.goto("/library");
    await waitForLibrary(page);
    await page.getByLabel("Search vocabulary").fill(a.madi);
    const cardA = page.locator(`[data-entry-id="${a.id}"]`);
    const cardB = page.locator(`[data-entry-id="${b.id}"]`);
    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();

    const toggleA = cardA.locator("xpath=..").getByTestId("bookmark-toggle");
    const toggleB = cardB.locator("xpath=..").getByTestId("bookmark-toggle");
    await toggleA.click();
    await toggleB.click();
    await expect(toggleA).toHaveAttribute("data-bookmarked", "true");
    await expect(toggleB).toHaveAttribute("data-bookmarked", "true");

    await page.goto("/library/saved");
    const linkA = page.locator(`a[href="/library/${a.id}"]`);
    const linkB = page.locator(`a[href="/library/${b.id}"]`);
    await expect(linkA).toBeVisible();
    await expect(linkB).toBeVisible();

    // Removing one does not remove the other; distinct routes stay correct.
    const rowA = page.locator(`li:has(a[href="/library/${a.id}"])`);
    await rowA.getByTestId("bookmark-toggle").click();
    await expect(linkA).toHaveCount(0);
    await expect(linkB).toBeVisible();
  });
});

test.describe("31.4 — create and manage list", () => {
  test("create a list from detail, manage membership from Saved Vocabulary, rename and membership persist across reload", async ({
    page,
  }) => {
    // entryB is located by searching its meaning in the add-entries dialog,
    // so it must have a meaning no other entry shares.
    const entryB = uniqueMeaningEntry();
    const entryA = loadLearnerRelease().entries.find(
      (entry) => entry.id !== entryB.id,
    )!;

    await page.goto(`/library/${entryA.id}`);
    await page.getByRole("button", { name: "Add to list" }).click();
    const addToListDialog = page.getByTestId("add-to-list-dialog");
    await addToListDialog.getByLabel("New list").fill("E2E list");
    await addToListDialog.getByRole("button", { name: "Create & add" }).click();
    await expect(addToListDialog.getByRole("checkbox")).toBeChecked();
    await addToListDialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("detail-list-membership")).toContainText(
      "E2E list",
    );

    await page.goto("/library/saved");
    await page.getByRole("link", { name: "Open list" }).click();
    await expect(page.getByTestId("custom-list-detail")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: "E2E list", level: 1 }),
    ).toBeVisible();

    // Add a second entry via the list detail's "Add entries" search.
    await page.getByRole("button", { name: "Add entries" }).click();
    const addEntriesDialog = page.getByTestId("add-entries-dialog");
    await addEntriesDialog.getByLabel("Search vocabulary").fill(entryB.meaning);
    await addEntriesDialog
      .getByRole("button", { name: addToListLabel(entryB.meaning) })
      .click();
    await expect(
      addEntriesDialog.getByRole("button", {
        name: alreadyInListLabel(entryB.meaning),
      }),
    ).toBeVisible();
    await addEntriesDialog.getByRole("button", { name: "Done" }).click();

    // Rename.
    await page.getByRole("button", { name: "Rename" }).click();
    const renameDialog = page.getByTestId("rename-list-dialog");
    await renameDialog.getByLabel("List name").fill("Renamed E2E list");
    await renameDialog.getByRole("button", { name: "Save name" }).click();
    await expect(
      page.getByRole("heading", { name: "Renamed E2E list", level: 1 }),
    ).toBeVisible();

    // Reload: name and membership persist.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Renamed E2E list", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("custom-list-entries")).toContainText(
      entryA.meaning,
    );
    await expect(page.getByTestId("custom-list-entries")).toContainText(
      entryB.meaning,
    );

    // Remove one entry; the other remains.
    await page
      .getByRole("button", { name: removeFromListLabel(entryA.meaning) })
      .click();
    await expect(page.getByTestId("custom-list-entries")).not.toContainText(
      entryA.meaning,
    );
    await expect(page.getByTestId("custom-list-entries")).toContainText(
      entryB.meaning,
    );
  });
});

test.describe("31.5 — delete list", () => {
  test("deleting a list removes it but preserves bookmarks and study state; the deleted-list route and Custom Session stay safe", async ({
    page,
  }) => {
    const entries = loadLearnerRelease().entries;
    const [entryA, entryB] = entries;
    const listId = "e2e-delete-list";

    await page.goto("/library"); // establish the Dexie schema first
    await waitForLibrary(page);
    await idbSeed(page, "lists", [
      seedList({
        id: listId,
        name: "Temp list",
        entryIds: [entryA.id, entryB.id],
        createdAtMs: 1,
      }),
    ]);
    await idbSeed(page, "bookmarks", [seedBookmark(entryA.id, 1)]);
    await idbSeed(page, "study_attempts", [
      {
        id: "e2e-attempt-1",
        componentKey: "e2e-untouched",
        sessionId: "e2e-session-1",
        attemptedAt: 1,
      },
    ]);

    await page.goto("/library/saved");
    await expect(
      page.getByRole("heading", { name: "Temp list", level: 3 }),
    ).toBeVisible();

    const card = page
      .getByTestId("custom-list-card")
      .filter({ hasText: "Temp list" });
    await card.getByRole("button", { name: "Delete" }).click();
    await page
      .getByTestId("delete-list-dialog")
      .getByRole("button", { name: "Delete list" })
      .click();
    await expect(page.getByText("Temp list")).toHaveCount(0);

    // Bookmark remains.
    await expect(
      page.getByRole("link", { name: entryA.meaning }),
    ).toBeVisible();

    // Progress (study state) remains untouched.
    expect(await idbAll(page, "study_attempts")).toHaveLength(1);

    // Direct deleted-list route is safe.
    await page.goto(`/library/saved/lists/${listId}`);
    await expect(page.getByText("List not found")).toBeVisible();

    // Custom Session no longer offers it.
    await page.goto("/study/custom");
    await expect(
      page.getByTestId(`custom-collection-list-${listId}`),
    ).toHaveCount(0);
  });
});

test.describe("31.6 — session-result bookmark", () => {
  test("bookmarking from MC results shows each distinct entry once, even with a reinforced (recovered) component", async ({
    page,
  }) => {
    await page.goto("/settings");
    const input = page.getByTestId("study-default-questionCount");
    await input.fill("3");
    await page.getByTestId("study-defaults-save").click();
    await expect(page.getByText("Study defaults saved")).toBeVisible();

    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    // Fail the first question (queues one reinforcement item), then answer
    // every remaining question — including the reinforcement — correctly.
    await answerIncorrectly(page);
    await page.getByTestId("mc-next").click();

    const seenEntryIds: number[] = [];
    for (let i = 0; i < 20; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      const session = page.getByTestId("mc-quiz-session");
      const entryId = Number(await session.getAttribute("data-entry-id"));
      seenEntryIds.push(entryId);
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
      await expect(
        page.getByTestId("mc-results").or(page.getByTestId("mc-quiz-session")),
      ).toBeVisible();
    }
    await expect(page.getByTestId("mc-results")).toBeVisible();

    const distinctSeen = new Set(seenEntryIds);
    const summaryEntries = page.getByTestId("summary-entries");
    await expect(summaryEntries.getByTestId("summary-entry-link")).toHaveCount(
      distinctSeen.size,
    );

    const firstRow = summaryEntries.locator("li[data-entry-id]").first();
    const rowEntryId = await firstRow.getAttribute("data-entry-id");
    await firstRow.getByTestId("bookmark-toggle").click();
    await expect(firstRow.getByTestId("bookmark-toggle")).toHaveAttribute(
      "data-bookmarked",
      "true",
    );

    await page.goto("/library/saved");
    const bookmarkedEntry = loadLearnerRelease().entries.find(
      (entry) => entry.id === Number(rowEntryId),
    )!;
    await expect(
      page.getByRole("link", { name: bookmarkedEntry.meaning }),
    ).toBeVisible();
  });

  test("bookmarking from the flashcard session summary appears on Saved Vocabulary", async ({
    page,
  }) => {
    await page.goto("/settings");
    const input = page.getByTestId("study-default-questionCount");
    await input.fill("2");
    await page.getByTestId("study-defaults-save").click();
    await expect(page.getByText("Study defaults saved")).toBeVisible();

    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();
    for (let i = 0; i < 2; i++) {
      await page.getByTestId("flashcard").click();
      await page.getByTestId("rate-know").click();
    }
    await expect(page.getByTestId("session-summary")).toBeVisible();

    const summaryEntries = page.getByTestId("summary-entries");
    const firstRow = summaryEntries.locator("li[data-entry-id]").first();
    const rowEntryId = await firstRow.getAttribute("data-entry-id");
    await firstRow.getByTestId("bookmark-toggle").click();
    await expect(firstRow.getByTestId("bookmark-toggle")).toHaveAttribute(
      "data-bookmarked",
      "true",
    );

    await page.goto("/library/saved");
    const bookmarkedEntry = loadLearnerRelease().entries.find(
      (entry) => entry.id === Number(rowEntryId),
    )!;
    await expect(
      page.getByRole("link", { name: bookmarkedEntry.meaning }),
    ).toBeVisible();
  });
});

test.describe("31.7 — bookmarked-only Custom Session", () => {
  test("selecting Bookmarks restricts every question to the bookmarked subset", async ({
    page,
  }) => {
    const entries = loadLearnerRelease().entries;
    const bookmarked = new Set([entries[0].id, entries[2].id, entries[4].id]);

    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(
      page,
      "bookmarks",
      [...bookmarked].map((id, index) => seedBookmark(id, index + 1)),
    );

    await page.goto("/study/custom");
    await page.getByTestId("custom-collection-bookmarks").click();
    await page.getByTestId("custom-count").fill("15");
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    let questionCount = 0;
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      const session = page.getByTestId("mc-quiz-session");
      if (!(await session.isVisible())) break;
      const entryId = Number(await session.getAttribute("data-entry-id"));
      expect(bookmarked.has(entryId)).toBe(true);
      questionCount += 1;
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
      await expect(
        page.getByTestId("mc-results").or(page.getByTestId("mc-quiz-session")),
      ).toBeVisible();
    }
    expect(questionCount).toBeGreaterThan(0);
  });
});

test.describe("31.8 — list-only Custom Session", () => {
  test("'Study this list' preselects the list; every question belongs to it and matches the applied form filter", async ({
    page,
  }) => {
    const entries = loadLearnerRelease().entries;
    const members = new Set([entries[0].id, entries[1].id]);
    const listId = "e2e-study-list-only";

    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(page, "lists", [
      seedList({
        id: listId,
        name: "Study-only list",
        entryIds: [...members],
        createdAtMs: 1,
      }),
    ]);

    await page.goto("/library/saved");
    await page.getByRole("link", { name: "Study list" }).click();
    await expect(page).toHaveURL(/\/study\/custom\?list=/);
    await expect(
      page.getByTestId(`custom-collection-list-${listId}`),
    ).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("custom-form-madi").click();
    await page.getByTestId("custom-count").fill("15");
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    let questionCount = 0;
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      const session = page.getByTestId("mc-quiz-session");
      if (!(await session.isVisible())) break;
      const entryId = Number(await session.getAttribute("data-entry-id"));
      const sourceField = await session.getAttribute("data-source-field");
      expect(members.has(entryId)).toBe(true);
      expect(sourceField).toBe("madi");
      questionCount += 1;
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
      await expect(
        page.getByTestId("mc-results").or(page.getByTestId("mc-quiz-session")),
      ).toBeVisible();
    }
    expect(questionCount).toBeGreaterThan(0);
  });
});

test.describe("31.9 — collection union/intersection", () => {
  test("List A OR List B unions across the collection axis; adding a bāb filter intersects across axes", async ({
    page,
  }) => {
    const { babA, entriesA, entriesB } = twoBabsWithTwoEntries();
    const listAId = "e2e-union-list-a";
    const listBId = "e2e-union-list-b";

    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(page, "lists", [
      seedList({
        id: listAId,
        name: "Union list A",
        entryIds: entriesA.map((entry) => entry.id),
        createdAtMs: 1,
      }),
      seedList({
        id: listBId,
        name: "Union list B",
        entryIds: entriesB.map((entry) => entry.id),
        createdAtMs: 2,
      }),
    ]);

    const union = new Set([
      ...entriesA.map((entry) => entry.id),
      ...entriesB.map((entry) => entry.id),
    ]);

    await page.goto("/study/custom");
    await page.getByTestId(`custom-collection-list-${listAId}`).click();
    await page.getByTestId(`custom-collection-list-${listBId}`).click();
    await page.getByTestId("custom-count").fill("15");
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    let unionQuestions = 0;
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      const session = page.getByTestId("mc-quiz-session");
      if (!(await session.isVisible())) break;
      const entryId = Number(await session.getAttribute("data-entry-id"));
      expect(union.has(entryId)).toBe(true);
      unionQuestions += 1;
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
      await expect(
        page.getByTestId("mc-results").or(page.getByTestId("mc-quiz-session")),
      ).toBeVisible();
    }
    expect(unionQuestions).toBeGreaterThan(0);

    // (List A OR List B) AND bāb A — only List A's entries qualify, since
    // List B's entries belong to a different bāb.
    await page.getByTestId("custom-adjust-filters").click();
    await page.getByTestId(`custom-bab-${babA}`).click();
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    const entryIdsA = new Set(entriesA.map((entry) => entry.id));
    let intersectionQuestions = 0;
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      const session = page.getByTestId("mc-quiz-session");
      if (!(await session.isVisible())) break;
      const entryId = Number(await session.getAttribute("data-entry-id"));
      expect(entryIdsA.has(entryId)).toBe(true);
      intersectionQuestions += 1;
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
      await expect(
        page.getByTestId("mc-results").or(page.getByTestId("mc-quiz-session")),
      ).toBeVisible();
    }
    expect(intersectionQuestions).toBeGreaterThan(0);
  });
});

test.describe("31.10 — selected empty collection", () => {
  test("an explicitly selected empty Bookmarks or empty list never starts an unrestricted session", async ({
    page,
  }) => {
    const emptyListId = "e2e-empty-list";
    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(page, "lists", [
      seedList({ id: emptyListId, name: "Empty list", createdAtMs: 1 }),
    ]);

    // Empty Bookmarks (a fresh guest has none).
    await page.goto("/study/custom");
    await page.getByTestId("custom-collection-bookmarks").click();
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("custom-empty-guard")).toBeVisible();
    await expect(
      page.getByTestId("loosen-suggestion").filter({ hasText: /bookmark/i }),
    ).toBeVisible();
    await expect(page.getByTestId("mc-quiz-session")).toHaveCount(0);

    // An explicitly selected but empty list.
    await page.getByTestId("custom-collection-bookmarks").click();
    await page.getByTestId(`custom-collection-list-${emptyListId}`).click();
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("custom-empty-guard")).toBeVisible();
    await expect(page.getByTestId("mc-quiz-session")).toHaveCount(0);
  });
});

test.describe("31.11 — Study Again refresh", () => {
  test("Study Again re-plans against the list's CURRENT membership, not the one captured at the first Start", async ({
    page,
  }) => {
    const entries = loadLearnerRelease().entries;
    const [firstMember, replacementMember] = entries;
    const listId = "e2e-study-again-list";

    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(page, "lists", [
      seedList({
        id: listId,
        name: "Study again list",
        entryIds: [firstMember.id],
        createdAtMs: 1,
      }),
    ]);

    await page.goto(`/study/custom?list=${listId}`);
    await expect(
      page.getByTestId(`custom-collection-list-${listId}`),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("custom-count").fill("1");
    await page.getByTestId("custom-start").click();

    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    expect(await session.getAttribute("data-entry-id")).toBe(
      String(firstMember.id),
    );
    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();
    await expect(page.getByTestId("mc-results")).toBeVisible();

    // The list is edited in another navigation flow / seeded transaction
    // while the results screen is showing.
    await idbSeed(page, "lists", [
      seedList({
        id: listId,
        name: "Study again list",
        entryIds: [replacementMember.id],
        createdAtMs: 1,
        updatedAtMs: 2,
      }),
    ]);

    await page.getByTestId("study-again").click();
    const nextSession = page.getByTestId("mc-quiz-session");
    await expect(nextSession).toBeVisible();
    expect(await nextSession.getAttribute("data-entry-id")).toBe(
      String(replacementMember.id),
    );
  });
});

test.describe("31.12 — export", () => {
  test("Export My Data includes bookmarks/lists with canonical membership and excludes content artifacts and daily_activity", async ({
    page,
  }) => {
    const entries = loadLearnerRelease().entries;
    const [bookmarkedEntry, listEntryA, listEntryB] = entries;
    const listId = "e2e-export-list";

    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(page, "bookmarks", [seedBookmark(bookmarkedEntry.id, 1)]);
    // Out-of-order, duplicated membership — the export must reflect the
    // canonicalised (deduped, sorted) form written by the persistence layer,
    // so seed it via that layer's actual on-disk shape (already canonical).
    await idbSeed(page, "lists", [
      seedList({
        id: listId,
        name: "Export list",
        entryIds: [listEntryA.id, listEntryB.id].sort((a, b) => a - b),
        createdAtMs: 2,
      }),
    ]);

    await page.goto("/settings");
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-my-data").click();
    const download = await downloadPromise;
    const path = await download.path();
    const fs = await import("node:fs");
    const parsed = JSON.parse(fs.readFileSync(path!, "utf8")) as {
      bookmarks: { entryId: number; createdAt: number }[];
      lists: { id: string; name: string; entryIds: number[] }[];
    };

    expect(parsed.bookmarks).toContainEqual({
      entryId: bookmarkedEntry.id,
      createdAt: 1,
    });
    const exportedList = parsed.lists.find((list) => list.id === listId)!;
    expect(exportedList.name).toBe("Export list");
    expect(exportedList.entryIds).toEqual(
      [listEntryA.id, listEntryB.id].sort((a, b) => a - b),
    );

    const raw = fs.readFileSync(path!, "utf8");
    expect(raw).not.toContain("serializedLearner");
    expect(raw).not.toContain("daily_activity");
    expect(raw).not.toContain("dailyActivity");
  });
});

test.describe("31.13 — browser restart persistence", () => {
  test("bookmarks and lists survive a full browser restart", async ({
    baseURL,
  }, testInfo) => {
    const entries = loadLearnerRelease().entries;
    const [bookmarkedEntry] = entries;
    const listId = "e2e-restart-list";
    const userDataDir = testInfo.outputPath("collections-restart-user-data");
    const launch = () => chromium.launchPersistentContext(userDataDir);

    let context = await launch();
    try {
      const page = await context.newPage();
      await page.goto(`${baseURL}/library`);
      await waitForLibrary(page);
      await idbSeed(page, "bookmarks", [seedBookmark(bookmarkedEntry.id, 1)]);
      await idbSeed(page, "lists", [
        seedList({ id: listId, name: "Restart list", createdAtMs: 2 }),
      ]);
      const bookmarksBefore = await idbAll(page, "bookmarks");
      expect(bookmarksBefore).toHaveLength(1);
    } finally {
      await context.close();
    }

    context = await launch();
    try {
      const page = await context.newPage();
      await page.goto(`${baseURL}/library/saved`);
      await expect(
        page.getByRole("link", { name: bookmarkedEntry.meaning }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Restart list", level: 3 }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("31.14 — mobile 320px", () => {
  test("bookmark, create a list, add an entry, start a list session and bookmark from results — all reachable at 320px with no overflow", async ({
    page,
  }) => {
    const entries = loadLearnerRelease().entries;
    const target = uniqueMeaningEntry();
    const secondEntry = entries.find((entry) => entry.id !== target.id)!;

    await page.setViewportSize({ width: 320, height: 700 });

    await page.goto("/library");
    await waitForLibrary(page);
    await expectNoHorizontalOverflow(page, 320);
    await page.getByLabel("Search vocabulary").fill(target.meaning);
    await page
      .getByRole("button", { name: `Save "${target.meaning}"` })
      .click();
    await expect(
      page.getByRole("button", {
        name: `Remove "${target.meaning}" from bookmarks`,
      }),
    ).toHaveAttribute("data-bookmarked", "true");

    await page.goto("/library/saved");
    await expectNoHorizontalOverflow(page, 320);
    await expect(
      page.getByRole("link", { name: target.meaning }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Create list" }).click();
    const createDialog = page.getByTestId("create-list-dialog");
    await createDialog.getByLabel("List name").fill("Mobile list");
    await createDialog.getByRole("button", { name: "Create list" }).click();
    await expect(
      page.getByRole("heading", { name: "Mobile list", level: 3 }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Open list" }).click();
    await expectNoHorizontalOverflow(page, 320);
    await page.getByRole("button", { name: "Add entries" }).click();
    const addEntriesDialog = page.getByTestId("add-entries-dialog");
    await addEntriesDialog
      .getByLabel("Search vocabulary")
      .fill(secondEntry.meaning);
    await addEntriesDialog
      .getByRole("button", { name: addToListLabel(secondEntry.meaning) })
      .click();
    await addEntriesDialog.getByRole("button", { name: "Done" }).click();

    await page.getByRole("link", { name: "Study list" }).click();
    await expectNoHorizontalOverflow(page, 320);
    await page.getByTestId("custom-count").fill("1");
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();
    await expect(page.getByTestId("mc-results")).toBeVisible();
    await expectNoHorizontalOverflow(page, 320);

    const summaryEntries = page.getByTestId("summary-entries");
    await summaryEntries
      .locator("li[data-entry-id]")
      .first()
      .getByTestId("bookmark-toggle")
      .click();
    await expect(
      summaryEntries
        .locator("li[data-entry-id]")
        .first()
        .getByTestId("bookmark-toggle"),
    ).toHaveAttribute("data-bookmarked", "true");
  });
});

test.describe("31.15 — accessibility", () => {
  test("Library with bookmark controls and detail with collection actions have no serious/critical violations", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/library");
    await waitForLibrary(page);
    await expectNoSeriousViolations(page);

    await page.goto(`/library/${target.id}`);
    await expect(page.getByTestId("entry-detail")).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("empty and populated Saved Vocabulary have no serious/critical violations", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/library/saved");
    await expectNoSeriousViolations(page);

    const target = uniqueMeaningEntry();
    await page.goto("/library");
    await waitForLibrary(page);
    await page.getByLabel("Search vocabulary").fill(target.meaning);
    await page
      .getByRole("button", { name: `Save "${target.meaning}"` })
      .click();
    await page.goto("/library/saved");
    await expect(
      page.getByRole("link", { name: target.meaning }),
    ).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("custom-list detail, add-to-list dialog and delete confirmation have no serious/critical violations", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    const listId = "e2e-a11y-list";
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(page, "lists", [
      seedList({
        id: listId,
        name: "A11y list",
        entryIds: [target.id],
        createdAtMs: 1,
      }),
    ]);

    await page.goto(`/library/saved/lists/${listId}`);
    await expect(page.getByTestId("custom-list-detail")).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.goto(`/library/${target.id}`);
    await page.getByRole("button", { name: "Add to list" }).click();
    const addToListDialog = page.getByTestId("add-to-list-dialog");
    await expect(addToListDialog).toBeVisible();
    // Radix's dialog-open fade/zoom animation leaves elements transiently
    // semi-transparent; wait for it to settle before sampling contrast, or
    // axe can flag an in-flight frame as a false-positive violation.
    await expect(addToListDialog).toHaveCSS("opacity", "1");
    await expectNoSeriousViolations(page);
    await page.keyboard.press("Escape");

    await page.goto("/library/saved");
    const card = page
      .getByTestId("custom-list-card")
      .filter({ hasText: "A11y list" });
    await card.getByRole("button", { name: "Delete" }).click();
    const deleteDialog = page.getByTestId("delete-list-dialog");
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toHaveCSS("opacity", "1");
    await expectNoSeriousViolations(page);
  });

  test("Custom Session collections filter and session results have no serious/critical violations", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/study/custom");
    await expect(page.getByTestId("custom-setup")).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.getByTestId("custom-count").fill("1");
    await page.getByTestId("custom-start").click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();
    await expect(page.getByTestId("mc-results")).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("mobile and dark-mode Saved Vocabulary have no serious/critical violations", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    await page.goto("/library");
    await waitForLibrary(page);
    await idbSeed(page, "bookmarks", [seedBookmark(target.id, 1)]);

    await page.setViewportSize({ width: 320, height: 700 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/library/saved");
    await expect(
      page.getByRole("link", { name: target.meaning }),
    ).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/library/saved");
    await expect(
      page.getByRole("link", { name: target.meaning }),
    ).toBeVisible();
    await expectNoSeriousViolations(page);
  });
});
