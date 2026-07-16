import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  ineligibleDisplayedFieldEntry,
  loadLearnerRelease,
  transcriptionNoteEntry,
  unresolvedRootEntry,
} from "./helpers/learner-release";

const INTERNAL_FIELD_NAMES = [
  "root_provenance",
  "data_quality",
  "requires_manual_review",
  "blocked_by",
  "additional_forms",
  "generated_additional_forms",
  "mazid_fih_patterns",
  "mazid_fih_entries",
  "internally_validated",
  "needs_review",
];

async function expectNoInternalMetadata(page: Page) {
  const body = await page.evaluate(() => document.body.innerHTML);
  for (const forbidden of INTERNAL_FIELD_NAMES) {
    expect(body, `internal field ${forbidden} leaked`).not.toContain(forbidden);
  }
}

test.describe("vocabulary detail", () => {
  test("opens from the library and shows the full learner-safe record", async ({
    page,
  }) => {
    const first = loadLearnerRelease().entries[0];
    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 15_000 },
    );
    await page.locator(`[data-entry-id="${first.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/library/${first.id}$`));

    await expect(page.getByTestId("detail-madi")).toHaveText(first.madi);
    await expect(page.getByTestId("detail-madi")).toHaveAttribute("lang", "ar");
    // The entry title is the page's level-one heading (screen-reader
    // heading navigation must find a page title).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      first.madi,
    );
    await expect(page.getByTestId("detail-meaning")).toHaveText(first.meaning);
    const mudari = page.getByTestId("detail-mudari");
    await expect(mudari.locator('[lang="ar"][dir="rtl"]')).toHaveText(
      first.mudari,
    );
    const babArabic = page.getByTestId("detail-bab-arabic");
    await expect(babArabic.locator('[lang="ar"][dir="rtl"]')).toHaveText(
      first.bab_arabic,
    );
    await expect(page.getByText(`Entry #${first.id}`)).toBeVisible();
    await expect(page.getByTestId("detail-book-page")).toContainText(
      String(first.book_page),
    );
    expect(
      await page.getByText("Quizzed", { exact: true }).count(),
    ).toBeGreaterThan(3);

    await page.getByRole("link", { name: /back to library/i }).click();
    await expect(page).toHaveURL(/\/library$/);
  });

  test("shows the printed-source note and marks the ineligible field", async ({
    page,
  }) => {
    const noteEntry = transcriptionNoteEntry();
    const { entry: ineligibleEntry, field } = ineligibleDisplayedFieldEntry();
    await page.goto(`/library/${noteEntry.id}`);
    const note = page.getByTestId("detail-note");
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note).toContainText(noteEntry.transcription_note!);
    await expectNoInternalMetadata(page);

    await page.goto(`/library/${ineligibleEntry.id}`);
    await expect(page.getByTestId("detail-madi")).toBeVisible({
      timeout: 15_000,
    });
    // The ineligible field is displayed AND marked not quizzed.
    const fieldTestId = `detail-${field}`;
    const fieldLocator = page.getByTestId(fieldTestId);
    if ((await fieldLocator.count()) > 0) {
      await expect(fieldLocator.getByText("Not quizzed")).toBeVisible();
    } else {
      // Field without a dedicated test id: at least one Not quizzed badge.
      await expect(page.getByText("Not quizzed").first()).toBeVisible();
    }
  });

  test("entry 369 hides the unresolved root and marks verb type not quizzed", async ({
    page,
  }) => {
    const entry = unresolvedRootEntry();
    await page.goto(`/library/${entry.id}`);
    const root = page.getByTestId("detail-root");
    await expect(root).toBeVisible({ timeout: 15_000 });
    await expect(root).toContainText("Not available — awaiting verification");
    await expect(root.getByText("Not quizzed")).toBeVisible();
    // No Arabic root value is rendered inside the root field.
    expect(await root.locator('[lang="ar"]').count()).toBe(0);
    const verbType = page.getByTestId("detail-verb-type");
    await expect(verbType.getByText("Not quizzed")).toBeVisible();
    await expectNoInternalMetadata(page);
  });

  test("invalid and absent ids show a safe not-found state", async ({
    page,
  }) => {
    for (const bad of ["abc", "0", "9999"]) {
      await page.goto(`/library/${bad}`);
      await expect(page.getByText("Entry not found")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByRole("link", { name: /back to library/i }),
      ).toBeVisible();
    }
  });

  test("library page renders no internal metadata", async ({ page }) => {
    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 15_000 },
    );
    await expectNoInternalMetadata(page);
  });
});
