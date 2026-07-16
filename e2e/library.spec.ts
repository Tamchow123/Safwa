import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  duplicateMadiPair,
  expectedFirstIds,
  lastEntry,
  loadLearnerRelease,
  uniqueArabicForm,
  uniqueMeaningEntry,
} from "./helpers/learner-release";

const TOTAL = loadLearnerRelease().entry_count;

async function waitForLibrary(page: Page) {
  await expect(page.getByTestId("library-result-count")).toHaveText(
    /entries|matched/,
    { timeout: 15_000 },
  );
}

async function selectOption(page: Page, triggerId: string, optionName: RegExp) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: optionName }).click();
}

test.describe("library — loading and virtualisation", () => {
  test("loads with 455 entries and renders only a subset of rows", async ({
    page,
  }) => {
    await page.goto("/library");
    await waitForLibrary(page);
    await expect(page.getByTestId("library-result-count")).toHaveText(
      `${TOTAL} entries`,
    );
    await expect(page.getByTestId("content-release-id")).toContainText(
      /^safwa-/,
    );
    const rendered = await page.getByTestId("entry-card").count();
    expect(rendered).toBeGreaterThan(3);
    expect(rendered).toBeLessThan(100); // virtualised, not all 455
  });

  test("scrolling reaches the final entry", async ({ page }) => {
    const final = lastEntry();
    await page.goto("/library");
    await waitForLibrary(page);
    for (let i = 0; i < 30; i += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(100);
      if ((await page.locator(`[data-entry-id="${final.id}"]`).count()) > 0) {
        break;
      }
    }
    await expect(page.locator(`[data-entry-id="${final.id}"]`)).toBeVisible();
  });
});

test.describe("library — search", () => {
  test("finds a unique English meaning and restores on clear", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    await page.goto("/library");
    await waitForLibrary(page);
    await page.getByLabel("Search vocabulary").fill(target.meaning);
    await expect(page.getByTestId("library-result-count")).toHaveText(
      "1 entries match your filters",
    );
    await expect(page.locator(`[data-entry-id="${target.id}"]`)).toBeVisible();
    await page.getByLabel("Search vocabulary").fill("");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      `${TOTAL} entries`,
    );
  });

  test("finds a unique Arabic form and preserves exact display", async ({
    page,
  }) => {
    const { entry, value } = uniqueArabicForm();
    await page.goto("/library");
    await waitForLibrary(page);
    await page.getByLabel("Search vocabulary").fill(value);
    await expect(page.locator(`[data-entry-id="${entry.id}"]`)).toBeVisible();
    // The displayed madi is byte-exact and correctly marked as Arabic.
    const arabic = page
      .locator(`[data-entry-id="${entry.id}"]`)
      .locator('[lang="ar"][dir="rtl"]')
      .first();
    await expect(arabic).toHaveText(entry.madi);
  });

  test("duplicate-madi entries stay separate and distinguishable", async ({
    page,
  }) => {
    const [a, b] = duplicateMadiPair();
    await page.goto("/library");
    await waitForLibrary(page);
    await page.getByLabel("Search vocabulary").fill(a.madi);
    await expect(page.locator(`[data-entry-id="${a.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-entry-id="${b.id}"]`)).toBeVisible();
    // Their mudari values differ on the cards.
    const mudariA = await page
      .locator(`[data-entry-id="${a.id}"] [lang="ar"]`)
      .nth(1)
      .textContent();
    const mudariB = await page
      .locator(`[data-entry-id="${b.id}"] [lang="ar"]`)
      .nth(1)
      .textContent();
    expect(mudariA).toBe(a.mudari);
    expect(mudariB).toBe(b.mudari);
    expect(mudariA).not.toBe(mudariB);
  });
});

test.describe("library — filters and sorting", () => {
  test("bab, verb-type, page and eligibility filters compose and reset", async ({
    page,
  }) => {
    const entries = loadLearnerRelease().entries;
    const nasaraCount = entries.filter((e) => e.bab === "nasara").length;
    await page.goto("/library");
    await waitForLibrary(page);

    await selectOption(page, "filter-bab", /^nasara/);
    await expect(page.getByTestId("library-result-count")).toHaveText(
      `${nasaraCount} entries match your filters`,
    );
    for (const card of await page.getByTestId("entry-card").all()) {
      expect(await card.getAttribute("data-bab")).toBe("nasara");
    }

    await selectOption(page, "filter-eligibility", /Eligible for masdar/);
    const combined = entries.filter(
      (e) => e.bab === "nasara" && e.quiz_eligibility.masdar,
    ).length;
    await expect(page.getByTestId("library-result-count")).toHaveText(
      `${combined} entries match your filters`,
    );

    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page.getByTestId("library-result-count")).toHaveText(
      `${TOTAL} entries`,
    );

    await selectOption(page, "filter-verb-type", /^sahih$/);
    for (const card of await page.getByTestId("entry-card").all()) {
      expect(await card.getAttribute("data-verb-type")).toBe("sahih");
    }
    await page.getByRole("button", { name: "Reset filters" }).click();

    const firstPage = entries[0].book_page;
    await selectOption(
      page,
      "filter-book-page",
      new RegExp(`^Page ${firstPage}$`),
    );
    for (const card of await page.getByTestId("entry-card").all()) {
      expect(await card.getAttribute("data-book-page")).toBe(String(firstPage));
    }
  });

  test("sorting changes order and persists in the URL after reload", async ({
    page,
  }) => {
    const firstIds = expectedFirstIds();
    await page.goto("/library");
    await waitForLibrary(page);
    await expect(page.getByTestId("entry-card").first()).toHaveAttribute(
      "data-entry-id",
      "1",
    );

    await selectOption(page, "library-sort", /^Book page$/);
    await page.waitForURL(/sort=book-page/);
    await expect(page.getByTestId("entry-card").first()).toHaveAttribute(
      "data-entry-id",
      String(firstIds.bookPage),
    );

    await selectOption(page, "library-sort", /^Meaning/);
    await page.waitForURL(/sort=meaning/);
    await expect(page.getByTestId("entry-card").first()).toHaveAttribute(
      "data-entry-id",
      String(firstIds.meaning),
    );

    await page.reload();
    await waitForLibrary(page);
    await expect(page.getByTestId("entry-card").first()).toHaveAttribute(
      "data-entry-id",
      String(firstIds.meaning),
    );
  });

  test("URL state survives reload and back/forward; invalid params fall back", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    await page.goto("/library");
    await waitForLibrary(page);

    await selectOption(page, "filter-bab", /^daraba/);
    await page.waitForURL(/bab=daraba/);
    await page.getByLabel("Search vocabulary").fill(target.meaning);
    await page.waitForURL(/q=/);

    await page.reload();
    await waitForLibrary(page);
    await expect(page.getByLabel("Search vocabulary")).toHaveValue(
      target.meaning,
    );

    await page.goBack(); // back past the filter push
    await page.waitForURL((url) => !url.search.includes("bab=daraba"));
    await waitForLibrary(page);
    await page.goForward();
    await page.waitForURL(/bab=daraba/);
    await waitForLibrary(page);

    await page.goto("/library?bab=bogus&type=nope&page=zzz&sort=chaos");
    await waitForLibrary(page);
    await expect(page.getByTestId("library-result-count")).toHaveText(
      `${TOTAL} entries`,
    );
  });
});

test.describe("library — keyboard", () => {
  test("search, filter traversal and entry navigation work by keyboard", async ({
    page,
  }) => {
    const target = uniqueMeaningEntry();
    await page.goto("/library");
    await waitForLibrary(page);

    // Reach the search input with Tab alone (bounded traversal).
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      const focusedId = await page.evaluate(
        () => document.activeElement?.id ?? "",
      );
      if (focusedId === "library-search") break;
    }
    await expect(page.locator("#library-search")).toBeFocused();
    await page.keyboard.type(target.meaning);
    await expect(page.getByTestId("library-result-count")).toHaveText(
      "1 entries match your filters",
    );

    // Continue through the filter controls to the visible result link.
    let reachedCard = false;
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      const onCard = await page.evaluate(() =>
        document.activeElement?.hasAttribute("data-entry-id"),
      );
      if (onCard) {
        reachedCard = true;
        break;
      }
    }
    expect(reachedCard).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/library/${target.id}$`));
    await expect(page.getByTestId("detail-madi")).toBeVisible({
      timeout: 15_000,
    });

    // Reach the back link and return.
    let reachedBack = false;
    for (let i = 0; i < 15; i += 1) {
      await page.keyboard.press("Tab");
      const text = await page.evaluate(
        () => document.activeElement?.textContent ?? "",
      );
      if (text.includes("Back to library")) {
        reachedBack = true;
        break;
      }
    }
    expect(reachedBack).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/library$/);
  });
});

test.describe("library — mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile only");

  test("no horizontal overflow at 320px and content clears bottom nav", async ({
    page,
  }) => {
    const final = lastEntry();
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/library");
    await waitForLibrary(page);
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);

    // Scroll fully to the true bottom (virtual heights settle as items
    // measure), then the FINAL card must clear the fixed bottom nav.
    let previousY = -1;
    for (let i = 0; i < 40; i += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(120);
      const y = await page.evaluate(() => window.scrollY);
      if (
        y === previousY &&
        (await page.locator(`[data-entry-id="${final.id}"]`).count()) > 0
      ) {
        break;
      }
      previousY = y;
    }
    const navBox = await page.getByTestId("mobile-nav").boundingBox();
    const lastBox = await page
      .locator(`[data-entry-id="${final.id}"]`)
      .boundingBox();
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  });

  test("detail page has no horizontal overflow at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/library/1");
    await expect(page.getByTestId("detail-madi")).toBeVisible({
      timeout: 15_000,
    });
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
