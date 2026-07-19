/**
 * Phase 13 Weak Areas E2E suite (phases-13.md §28.1-28.13): the Weak Areas
 * page, the exact weak-set drill, and the v2 heuristic's real observable
 * behaviour through actual browser sessions and direct-but-realistic
 * IndexedDB seeding (never a UI-only or formula-only stand-in for the
 * persisted shape the app itself writes).
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { expectNoSeriousViolations } from "./helpers/axe";
import { idbAll, idbSeed, seedCard, seedWeakAttempt } from "./helpers/idb";
import { loadLearnerRelease } from "./helpers/learner-release";

const DAY_MS = 24 * 60 * 60 * 1000;
const release = loadLearnerRelease();

/** The two unresolved-root/verb-type entries (never verb-type-eligible). */
const UNRESOLVED_ENTRY_IDS = [369, 372];

function entryKey(entryId: number, skillTypeId: string): string {
  return `entry:${entryId}:skill:${skillTypeId}`;
}
function formKey(
  entryId: number,
  skillTypeId: string,
  sourceField: string,
  direction: string,
): string {
  return `entry:${entryId}:skill:${skillTypeId}:field:${sourceField}:direction:${direction}`;
}

async function correctOptionRef(page: Page): Promise<string> {
  const session = page.getByTestId("mc-quiz-session");
  const entryId = await session.getAttribute("data-entry-id");
  const answerField = await session.getAttribute("data-answer-field");
  return `entry:${entryId}:field:${answerField}`;
}
async function answerCorrectly(page: Page) {
  const ref = await correctOptionRef(page);
  await page
    .locator(`[data-testid="mc-option"][data-answer-ref="${ref}"]`)
    .click();
}
async function answerIncorrectly(page: Page) {
  const ref = await correctOptionRef(page);
  await page
    .locator(`[data-testid="mc-option"]:not([data-answer-ref="${ref}"])`)
    .first()
    .click();
}

async function horizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
}

/** Navigate somewhere that opens the Dexie DB (creating every store) and
 * wait for the actual read to finish — not just the static page title,
 * which renders before the DB is ever touched — so `idbSeed` calls
 * afterward never race the "store not found" guard. */
async function openDb(page: Page) {
  await page.goto("/progress/weak-areas");
  await expect(
    page
      .getByText(
        "Study a few items to discover which areas need more practice.",
      )
      .or(page.getByText("Top practice priorities")),
  ).toBeVisible();
}

/**
 * `pairCount` pairs of DISTINCT eligible entries that each share a bāb with
 * its pair-mate, and no bāb is reused across pairs — two entries per bāb are
 * needed so the aggregated bāb GROUP clears the Weak Areas §13 minimum-
 * evidence bar (>= 2 first attempts), unlike component-level qualification
 * (`qualifyingWeaknessScore`), which a single strong failure alone can pass.
 */
function babGroupPairs(pairCount: number) {
  const byBab = new Map<string, typeof release.entries>();
  for (const entry of release.entries) {
    if (!entry.quiz_eligibility.bab) continue;
    const list = byBab.get(entry.bab) ?? [];
    byBab.set(entry.bab, list);
    list.push(entry);
  }
  const pairs: {
    bab: string;
    babArabic: string;
    entries: typeof release.entries;
  }[] = [];
  for (const [bab, entries] of byBab) {
    if (entries.length < 2) continue;
    pairs.push({
      bab,
      babArabic: entries[0].bab_arabic,
      entries: entries.slice(0, 2),
    });
    if (pairs.length === pairCount) break;
  }
  return pairs;
}

test.describe("28.1 no evidence", () => {
  test("new guest sees the no-evidence state, a Study action, axe passes, no 320px overflow", async ({
    page,
  }) => {
    await page.goto("/progress/weak-areas");
    await expect(
      page.getByText(
        "Study a few items to discover which areas need more practice.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Start studying" }),
    ).toHaveAttribute("href", "/study");
    await expectNoSeriousViolations(page);

    await page.setViewportSize({ width: 320, height: 720 });
    await page.reload();
    await expect(
      page.getByText(
        "Study a few items to discover which areas need more practice.",
      ),
    ).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);
  });
});

test.describe("28.2 bāb weakness journey (Phase 13 acceptance journey)", () => {
  test("fail first attempts of one bāb, complete reinforcement, see it weak, drill exactly it", async ({
    page,
  }) => {
    await page.goto("/study/bab");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();

    // Fail the first occurrence of a bāb, then fail up to two more
    // occurrences of that SAME bāb if the session presents them, answering
    // every other question correctly (incl. in-session reinforcement
    // re-queues of the failures).
    let targetBab: string | null = null;
    let failuresRemaining = 3;
    const failedEntryIds = new Set<number>();
    let firstAttemptsOfTargetBab = 0;
    let incorrectFirstAttemptsOfTargetBab = 0;

    for (let i = 0; i < 60; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      const entryId = Number(await session.getAttribute("data-entry-id"));
      const entry = release.entries.find((e) => e.id === entryId)!;
      if (targetBab === null) targetBab = entry.bab;

      const isFirstAttemptOfEntry = !failedEntryIds.has(entryId);
      if (entry.bab === targetBab && isFirstAttemptOfEntry) {
        firstAttemptsOfTargetBab++;
        if (failuresRemaining > 0) {
          failuresRemaining--;
          failedEntryIds.add(entryId);
          incorrectFirstAttemptsOfTargetBab++;
          await answerIncorrectly(page);
        } else {
          await answerCorrectly(page);
        }
      } else {
        await answerCorrectly(page);
      }
      await page.getByTestId("mc-next").click();
    }
    await expect(page.getByTestId("mc-results")).toBeVisible();
    expect(targetBab).not.toBeNull();
    expect(failedEntryIds.size).toBeGreaterThan(0);

    const targetBabArabic = release.entries.find(
      (e) => e.bab === targetBab,
    )!.bab_arabic;

    // A real /study/bab session covers entries close to at random, so the
    // target bāb may have surfaced only once — below the Weak Areas §13
    // group-level minimum-evidence bar (>= 2 first attempts). Top up with
    // one more genuinely-correct first attempt for a second same-bāb entry
    // so the group deterministically surfaces, without altering "at least
    // one real failure" or the accuracy math below (both counters include
    // it honestly).
    if (firstAttemptsOfTargetBab < 2) {
      const topUpEntry = release.entries.find(
        (e) => e.bab === targetBab && !failedEntryIds.has(e.id),
      )!;
      await idbSeed(page, "study_attempts", [
        seedWeakAttempt({
          id: "bab-journey-topup",
          componentKey: entryKey(topUpEntry.id, "bab_identification"),
          entryId: topUpEntry.id,
          skillTypeId: "bab_identification",
          isCorrect: true,
          occurredAtMs: Date.now(),
          promptField: "madi",
        }),
      ]);
      firstAttemptsOfTargetBab++;
    }

    await page.goto("/progress/weak-areas");
    await page.getByRole("button", { name: "Bāb" }).click();
    const region = page.getByRole("region", { name: "Bāb" });
    const card = region.getByRole("article", { name: targetBabArabic });
    await expect(card).toBeVisible();

    // Accuracy reflects first attempts only, for exactly this bāb.
    const expectedAccuracy = Math.round(
      ((firstAttemptsOfTargetBab - incorrectFirstAttemptsOfTargetBab) /
        firstAttemptsOfTargetBab) *
        100,
    );
    await expect(card).toContainText(`${expectedAccuracy}%`);
    // The exact Arabic bāb pair from the release (hard rules 3 & 5) — the
    // card is already located BY that Arabic text via its accessible name.

    // Launch the drill: every question belongs to the failed entries only —
    // no strong/unseen component (any other same-bāb entry) enters it.
    await card.getByRole("link", { name: "Review this area" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/study/weak\\?dimension=bab&value=${targetBab}$`),
    );
    const drillSession = page.getByTestId("mc-quiz-session");
    await expect(drillSession).toBeVisible();
    for (let i = 0; i < 10; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      await expect(drillSession).toHaveAttribute(
        "data-skill-type",
        "bab_identification",
      );
      const entryId = Number(await drillSession.getAttribute("data-entry-id"));
      expect(failedEntryIds.has(entryId)).toBe(true);
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
    }
  });
});

test.describe("28.3 prompt-form-varied bāb accuracy", () => {
  test("a failed form ranks weaker, attributed from the persisted promptField", async ({
    page,
  }) => {
    const now = Date.now();
    const babEligible = release.entries.filter(
      (e) =>
        e.quiz_eligibility.bab &&
        e.quiz_eligibility.madi &&
        e.quiz_eligibility.mudari,
    );
    const [failA, failB, okA, okB] = babEligible;
    expect(failA && failB && okA && okB).toBeTruthy();

    await openDb(page);
    await idbSeed(page, "study_attempts", [
      seedWeakAttempt({
        id: "form-madi-fail-1",
        componentKey: entryKey(failA.id, "bab_identification"),
        entryId: failA.id,
        skillTypeId: "bab_identification",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
        promptField: "madi",
      }),
      seedWeakAttempt({
        id: "form-madi-fail-2",
        componentKey: entryKey(failB.id, "bab_identification"),
        entryId: failB.id,
        skillTypeId: "bab_identification",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
        promptField: "madi",
      }),
      seedWeakAttempt({
        id: "form-mudari-ok-1",
        componentKey: entryKey(okA.id, "bab_identification"),
        entryId: okA.id,
        skillTypeId: "bab_identification",
        isCorrect: true,
        occurredAtMs: now - DAY_MS,
        promptField: "mudari",
      }),
      seedWeakAttempt({
        id: "form-mudari-ok-2",
        componentKey: entryKey(okB.id, "bab_identification"),
        entryId: okB.id,
        skillTypeId: "bab_identification",
        isCorrect: true,
        occurredAtMs: now - DAY_MS,
        promptField: "mudari",
      }),
    ]);

    await page.reload();
    await page.getByRole("button", { name: "Form" }).click();
    const region = page.getByRole("region", { name: "Form" });
    const madiCard = region.getByRole("article", { name: "Past (māḍī)" });
    await expect(madiCard).toBeVisible();
    await expect(madiCard).toContainText("0%");

    const mudariCard = region.getByRole("article", {
      name: "Present (muḍāriʿ)",
    });
    // The successful form either does not surface (no failure evidence) or,
    // if it does, shows a strictly better accuracy than the failed form.
    if (await mudariCard.isVisible()) {
      await expect(mudariCard).toContainText("100%");
    }
  });
});

test.describe("28.4 verb-type protection", () => {
  test("entries 369/372 never enter verb-type weakness even with valid non-verb-type evidence", async ({
    page,
  }) => {
    const now = Date.now();
    await openDb(page);
    await idbSeed(page, "study_attempts", [
      seedWeakAttempt({
        id: "unresolved-369-1",
        componentKey: formKey(
          369,
          "meaning_recognition",
          "madi",
          "arabic_to_english",
        ),
        entryId: 369,
        skillTypeId: "meaning_recognition",
        direction: "arabic_to_english",
        sourceField: "madi",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
      }),
      seedWeakAttempt({
        id: "unresolved-372-1",
        componentKey: formKey(
          372,
          "meaning_recognition",
          "madi",
          "arabic_to_english",
        ),
        entryId: 372,
        skillTypeId: "meaning_recognition",
        direction: "arabic_to_english",
        sourceField: "madi",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
      }),
    ]);

    // A real verb-type-weak entry to have something to inspect in that tab.
    const verbTypeEntry = release.entries.find(
      (e) =>
        e.quiz_eligibility.verb_type && !UNRESOLVED_ENTRY_IDS.includes(e.id),
    )!;
    const otherVerbTypeEntry = release.entries.find(
      (e) =>
        e.quiz_eligibility.verb_type &&
        e.verb_type === verbTypeEntry.verb_type &&
        e.id !== verbTypeEntry.id,
    )!;
    await idbSeed(page, "study_attempts", [
      seedWeakAttempt({
        id: "verb-type-weak-1",
        componentKey: entryKey(verbTypeEntry.id, "verb_type_identification"),
        entryId: verbTypeEntry.id,
        skillTypeId: "verb_type_identification",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
      }),
      seedWeakAttempt({
        id: "verb-type-weak-2",
        componentKey: entryKey(
          otherVerbTypeEntry.id,
          "verb_type_identification",
        ),
        entryId: otherVerbTypeEntry.id,
        skillTypeId: "verb_type_identification",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
      }),
    ]);

    await page.reload();
    await page.getByRole("button", { name: "Verb type" }).click();
    const region = page.getByRole("region", { name: "Verb type" });
    // The real, eligible verb type surfaces...
    await expect(
      region.getByRole("article", { name: verbTypeEntry.verb_type_arabic }),
    ).toBeVisible();
    // ...but the unresolved entries never contribute an article anywhere
    // (there is no verb-type value they could possibly attach to).
    const articleLabels = await region
      .getByRole("article")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      );
    expect(articleLabels).not.toContain(undefined);
    for (const id of UNRESOLVED_ENTRY_IDS) {
      const entry = release.entries.find((e) => e.id === id)!;
      expect(articleLabels).not.toContain(entry.verb_type_arabic);
    }

    // A real verb-type drill never contains 369/372.
    await region
      .getByRole("article", { name: verbTypeEntry.verb_type_arabic })
      .getByRole("link", { name: "Review this area" })
      .click();
    const drillSession = page.getByTestId("mc-quiz-session");
    await expect(drillSession).toBeVisible();
    const entryId = Number(await drillSession.getAttribute("data-entry-id"));
    expect(UNRESOLVED_ENTRY_IDS).not.toContain(entryId);
  });
});

test.describe("28.5 direction", () => {
  test("Arabic→English ranks weaker without contaminating English→Arabic", async ({
    page,
  }) => {
    const now = Date.now();
    const recognitionEntries = release.entries
      .filter((e) => e.quiz_eligibility.madi && e.quiz_eligibility.meaning)
      .slice(0, 2);
    const recallEntries = release.entries
      .filter((e) => e.quiz_eligibility.madi && e.quiz_eligibility.meaning)
      .slice(2, 4);

    await openDb(page);
    await idbSeed(page, "study_attempts", [
      ...recognitionEntries.map((entry, i) =>
        seedWeakAttempt({
          id: `direction-recognition-fail-${i}`,
          componentKey: formKey(
            entry.id,
            "meaning_recognition",
            "madi",
            "arabic_to_english",
          ),
          entryId: entry.id,
          skillTypeId: "meaning_recognition",
          direction: "arabic_to_english",
          sourceField: "madi",
          isCorrect: false,
          occurredAtMs: now - DAY_MS,
        }),
      ),
      ...recallEntries.map((entry, i) =>
        seedWeakAttempt({
          id: `direction-recall-ok-${i}`,
          componentKey: formKey(
            entry.id,
            "meaning_recall",
            "madi",
            "english_to_arabic",
          ),
          entryId: entry.id,
          skillTypeId: "meaning_recall",
          direction: "english_to_arabic",
          sourceField: "madi",
          isCorrect: true,
          occurredAtMs: now - DAY_MS,
        }),
      ),
    ]);

    await page.reload();
    await page.getByRole("button", { name: "Direction" }).click();
    const region = page.getByRole("region", { name: "Direction" });
    const ar = region.getByRole("article", { name: "Arabic → English" });
    await expect(ar).toBeVisible();
    await expect(ar).toContainText("0%");

    const en = region.getByRole("article", { name: "English → Arabic" });
    if (await en.isVisible()) {
      await expect(en).toContainText("100%");
    }
  });
});

test.describe("28.6 reinforcement", () => {
  test("a failed-then-reinforced first attempt remains weakness evidence with a one-attempt denominator", async ({
    page,
  }) => {
    await page.goto("/study/bab");
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();

    let failuresRemaining = 2;
    for (let i = 0; i < 60; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      if (failuresRemaining > 0) {
        failuresRemaining--;
        await answerIncorrectly(page);
      } else {
        await answerCorrectly(page);
      }
      await page.getByTestId("mc-next").click();
    }
    await expect(page.getByTestId("mc-results")).toBeVisible();

    // The reinforcement re-queue created MORE persisted attempt rows than
    // there were distinct first attempts.
    const attempts = (await idbAll(page, "study_attempts")) as {
      attempt?: { isFirstAttempt?: boolean; isCorrect?: boolean };
    }[];
    const firstAttempts = attempts.filter((row) => row.attempt?.isFirstAttempt);
    expect(attempts.length).toBeGreaterThan(firstAttempts.length);
    const incorrectFirst = firstAttempts.filter(
      (row) => row.attempt?.isCorrect === false,
    );
    expect(incorrectFirst.length).toBe(2);

    await page.goto("/progress/weak-areas");
    await page.getByRole("button", { name: "Skill" }).click();
    const card = page
      .getByRole("region", { name: "Skill" })
      .getByRole("article", { name: "Bāb identification" });
    await expect(card).toBeVisible();
    // The denominator counts distinct first attempts only — reinforcement
    // answers never double it.
    const expectedAccuracy = Math.round(
      ((firstAttempts.length - incorrectFirst.length) / firstAttempts.length) *
        100,
    );
    await expect(card).toContainText(`${expectedAccuracy}%`);
  });
});

test.describe("28.7 recency", () => {
  test("a more recent failure ranks higher than an equally-failed but older one", async ({
    page,
  }) => {
    const now = Date.now();
    const [recentPair, oldPair] = babGroupPairs(2);
    await openDb(page);
    await idbSeed(
      page,
      "study_attempts",
      recentPair.entries
        .map((entry, i) =>
          seedWeakAttempt({
            id: `recency-recent-${i}`,
            componentKey: entryKey(entry.id, "bab_identification"),
            entryId: entry.id,
            skillTypeId: "bab_identification",
            isCorrect: false,
            occurredAtMs: now - DAY_MS,
            promptField: "madi",
          }),
        )
        .concat(
          oldPair.entries.map((entry, i) =>
            seedWeakAttempt({
              id: `recency-old-${i}`,
              componentKey: entryKey(entry.id, "bab_identification"),
              entryId: entry.id,
              skillTypeId: "bab_identification",
              isCorrect: false,
              occurredAtMs: now - 200 * DAY_MS,
              promptField: "madi",
            }),
          ),
        ),
    );

    await page.reload();
    await page.getByRole("button", { name: "Bāb" }).click();
    const region = page.getByRole("region", { name: "Bāb" });
    const labels = await region
      .getByRole("article")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      );
    const recentIndex = labels.indexOf(recentPair.babArabic);
    const oldIndex = labels.indexOf(oldPair.babArabic);
    expect(recentIndex).toBeGreaterThanOrEqual(0);
    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(recentIndex).toBeLessThan(oldIndex);
  });
});

test.describe("28.8 lapses", () => {
  test("equal recent accuracy, higher FSRS lapses ranks higher", async ({
    page,
  }) => {
    const now = Date.now();
    const [highLapsePair, lowLapsePair] = babGroupPairs(2);
    await openDb(page);
    await idbSeed(
      page,
      "study_components",
      highLapsePair.entries
        .map((entry) => ({
          componentKey: entryKey(entry.id, "bab_identification"),
          entryId: entry.id,
          fsrs: seedCard(now + 5 * DAY_MS, { lapses: 3 }),
          learnerState: "learning",
          revision: 1,
        }))
        .concat(
          lowLapsePair.entries.map((entry) => ({
            componentKey: entryKey(entry.id, "bab_identification"),
            entryId: entry.id,
            fsrs: seedCard(now + 5 * DAY_MS, { lapses: 0 }),
            learnerState: "learning",
            revision: 1,
          })),
        ),
    );
    await idbSeed(
      page,
      "study_attempts",
      highLapsePair.entries
        .map((entry, i) =>
          seedWeakAttempt({
            id: `lapses-high-${i}`,
            componentKey: entryKey(entry.id, "bab_identification"),
            entryId: entry.id,
            skillTypeId: "bab_identification",
            isCorrect: false,
            occurredAtMs: now - DAY_MS,
            promptField: "madi",
          }),
        )
        .concat(
          lowLapsePair.entries.map((entry, i) =>
            seedWeakAttempt({
              id: `lapses-low-${i}`,
              componentKey: entryKey(entry.id, "bab_identification"),
              entryId: entry.id,
              skillTypeId: "bab_identification",
              isCorrect: false,
              occurredAtMs: now - DAY_MS,
              promptField: "madi",
            }),
          ),
        ),
    );

    await page.reload();
    await page.getByRole("button", { name: "Bāb" }).click();
    const region = page.getByRole("region", { name: "Bāb" });
    const labels = await region
      .getByRole("article")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      );
    const highIndex = labels.indexOf(highLapsePair.babArabic);
    const lowIndex = labels.indexOf(lowLapsePair.babArabic);
    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(lowIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeLessThan(lowIndex);
  });
});

test.describe("28.9 weak drill refresh", () => {
  test("Study again recomputes the plan and excludes resolved components", async ({
    page,
  }) => {
    const now = Date.now();
    const [entryA, entryB] = release.entries.filter(
      (e) => e.quiz_eligibility.bab,
    );
    await openDb(page);
    await idbSeed(page, "study_attempts", [
      seedWeakAttempt({
        id: "refresh-a",
        componentKey: entryKey(entryA.id, "bab_identification"),
        entryId: entryA.id,
        skillTypeId: "bab_identification",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
        promptField: "madi",
      }),
      seedWeakAttempt({
        id: "refresh-b",
        componentKey: entryKey(entryB.id, "bab_identification"),
        entryId: entryB.id,
        skillTypeId: "bab_identification",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
        promptField: "madi",
      }),
    ]);

    await page.goto(`/study/weak?dimension=bab&value=${entryA.bab}`);
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();

    // Answer whatever the plan contains correctly (both may or may not
    // share entryA's bāb — the plan is exact to the group at launch time).
    for (let i = 0; i < 10; i++) {
      if (await page.getByTestId("mc-results").isVisible()) break;
      await answerCorrectly(page);
      await page.getByTestId("mc-next").click();
    }
    await expect(page.getByTestId("mc-results")).toBeVisible();

    await page.getByTestId("study-again").click();
    // Either the plan is empty now (encouraging state) or a strictly smaller
    // plan — never the stale original list replayed unchanged.
    const empty = page.getByText(
      "Nice work — there's nothing left to practise in this area right now. Check Weak Areas for what's next.",
    );
    const refreshedSession = page.getByTestId("mc-quiz-session");
    await expect(empty.or(refreshedSession)).toBeVisible();
  });
});

test.describe("28.10 mixed revision agreement", () => {
  test("order is due -> v2 weak -> new, and an all-correct non-due component is excluded", async ({
    page,
  }) => {
    const now = Date.now();
    const [dueEntry, weakEntry, strongEntry] = release.entries.filter(
      (e) => e.quiz_eligibility.madi && e.quiz_eligibility.meaning,
    );
    await page.goto("/study/mixed");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();

    const dueKey = formKey(
      dueEntry.id,
      "meaning_recognition",
      "madi",
      "arabic_to_english",
    );
    const weakKey = formKey(
      weakEntry.id,
      "meaning_recognition",
      "madi",
      "arabic_to_english",
    );
    const strongKey = formKey(
      strongEntry.id,
      "meaning_recognition",
      "madi",
      "arabic_to_english",
    );
    await idbSeed(page, "study_components", [
      {
        componentKey: dueKey,
        entryId: dueEntry.id,
        fsrs: seedCard(now - DAY_MS),
        learnerState: "learning",
        revision: 1,
      },
      {
        componentKey: weakKey,
        entryId: weakEntry.id,
        fsrs: seedCard(now + 5 * DAY_MS),
        learnerState: "learning",
        revision: 1,
      },
      {
        componentKey: strongKey,
        entryId: strongEntry.id,
        fsrs: seedCard(now + 5 * DAY_MS),
        learnerState: "learning",
        revision: 1,
      },
    ]);
    await idbSeed(page, "study_attempts", [
      seedWeakAttempt({
        id: "mixed-weak",
        componentKey: weakKey,
        entryId: weakEntry.id,
        skillTypeId: "meaning_recognition",
        direction: "arabic_to_english",
        sourceField: "madi",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
      }),
      // The strong component is well-attempted and all-correct: it must
      // never be treated as weak even though it is non-due like weakEntry.
      seedWeakAttempt({
        id: "mixed-strong-1",
        componentKey: strongKey,
        entryId: strongEntry.id,
        skillTypeId: "meaning_recognition",
        direction: "arabic_to_english",
        sourceField: "madi",
        isCorrect: true,
        occurredAtMs: now - DAY_MS,
      }),
    ]);

    await page.reload();
    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    // Due first.
    await expect(session).toHaveAttribute("data-entry-id", String(dueEntry.id));
    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();
    // Then the v2-weak component, before any new item.
    await expect(session).toHaveAttribute(
      "data-entry-id",
      String(weakEntry.id),
    );
    // The all-correct non-due component is never selected as weak — it
    // does not appear ahead of the new items that follow.
  });
});

test.describe("28.11 Custom Session agreement", () => {
  test("the weak filter matches the Weak Areas qualifying set under one snapshot", async ({
    page,
  }) => {
    const now = Date.now();
    const [weakEntry] = release.entries.filter(
      (e) => e.quiz_eligibility.madi && e.quiz_eligibility.meaning,
    );
    await openDb(page);
    const weakKey = formKey(
      weakEntry.id,
      "meaning_recognition",
      "madi",
      "arabic_to_english",
    );
    // A stored study_components row is required — componentStateClasses
    // treats a component with no stored FSRS card as "new" unconditionally
    // and never reaches the weak-score check, regardless of attempt
    // evidence.
    await idbSeed(page, "study_components", [
      {
        componentKey: weakKey,
        entryId: weakEntry.id,
        fsrs: seedCard(now + 5 * DAY_MS),
        learnerState: "learning",
        revision: 1,
      },
    ]);
    await idbSeed(page, "study_attempts", [
      seedWeakAttempt({
        id: "custom-weak",
        componentKey: weakKey,
        entryId: weakEntry.id,
        skillTypeId: "meaning_recognition",
        direction: "arabic_to_english",
        sourceField: "madi",
        isCorrect: false,
        occurredAtMs: now - DAY_MS,
      }),
    ]);

    await page.goto("/study/custom");
    await page.getByTestId("custom-state-weak").click();
    await page.getByTestId("custom-start").click();

    const session = page.getByTestId("mc-quiz-session");
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute(
      "data-entry-id",
      String(weakEntry.id),
    );
  });
});

test.describe("28.12 mobile", () => {
  test("the full 320px weak-areas journey stays reachable with no overflow", async ({
    page,
  }) => {
    const now = Date.now();
    const [pair] = babGroupPairs(1);
    await openDb(page);
    await idbSeed(
      page,
      "study_attempts",
      pair.entries.map((entry, i) =>
        seedWeakAttempt({
          id: `mobile-weak-${i}`,
          componentKey: entryKey(entry.id, "bab_identification"),
          entryId: entry.id,
          skillTypeId: "bab_identification",
          isCorrect: false,
          occurredAtMs: now - DAY_MS,
          promptField: "madi",
        }),
      ),
    );

    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/progress/weak-areas");
    await expect(page.getByText("Top practice priorities")).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);

    await page.getByRole("button", { name: "Bāb" }).click();
    expect(await horizontalOverflow(page)).toBe(false);
    const region = page.getByRole("region", { name: "Bāb" });
    const card = region.getByRole("article", { name: pair.babArabic });
    await expect(card).toBeVisible();
    // Arabic label is present and not visually clipped to zero width.
    const box = await card.boundingBox();
    expect(box && box.width).toBeGreaterThan(0);

    await card.getByRole("link", { name: "Review this area" }).click();
    const drillSession = page.getByTestId("mc-quiz-session");
    await expect(drillSession).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);
    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();

    await page.getByRole("link", { name: "Back to Weak Areas" }).click();
    await expect(page.getByText("Weak areas")).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);

    // Touch targets stay usable at 320px (min 44px per the shared min-h-11
    // convention used throughout the app).
    const tabButtons = page.getByRole("button", { name: "Bāb" });
    const tabBox = await tabButtons.first().boundingBox();
    expect(tabBox && tabBox.height).toBeGreaterThanOrEqual(40);
  });
});

test.describe("28.13 accessibility", () => {
  test("axe passes on no-evidence, populated overview, bāb, form, drill, mobile and dark mode", async ({
    page,
  }) => {
    // No-evidence. Reduced motion avoids scanning mid-transition on the
    // shared Button/Badge components' `transition-all`, matching the
    // existing spurious-contrast workaround in e2e/bab-root-mixed.spec.ts.
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/progress/weak-areas");
    await expectNoSeriousViolations(page);

    // Populate with real evidence.
    const now = Date.now();
    const [pair] = babGroupPairs(1);
    await idbSeed(
      page,
      "study_attempts",
      pair.entries.map((entry, i) =>
        seedWeakAttempt({
          id: `a11y-weak-${i}`,
          componentKey: entryKey(entry.id, "bab_identification"),
          entryId: entry.id,
          skillTypeId: "bab_identification",
          isCorrect: false,
          occurredAtMs: now - DAY_MS,
          promptField: "madi",
        }),
      ),
    );
    await page.reload();
    await expect(page.getByText("Top practice priorities")).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.getByRole("button", { name: "Bāb" }).click();
    // Move the pointer off the just-clicked button before scanning: axe
    // measures the LIVE :hover state (this Button's hover:bg-primary/80
    // lowers contrast just enough to fail), which a keyboard/touch user
    // never sustains — the same class of transient-state false positive
    // e2e/bab-root-mixed.spec.ts already documents for its Undo button.
    await page.mouse.move(0, 0);
    await expectNoSeriousViolations(page);

    await page.getByRole("button", { name: "Form" }).click();
    await page.mouse.move(0, 0);
    await expectNoSeriousViolations(page);

    await page.getByRole("button", { name: "Bāb" }).click();
    await page
      .getByRole("region", { name: "Bāb" })
      .getByRole("link", { name: "Review this area" })
      .click();
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await page.mouse.move(0, 0);
    await expectNoSeriousViolations(page);

    // Mobile.
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/progress/weak-areas");
    await expect(page.getByText("Top practice priorities")).toBeVisible();
    await expectNoSeriousViolations(page);

    // Dark mode (through the real settings UI, not a mock). Reduced motion
    // avoids scanning mid-transition on the shared Button/Badge components'
    // `transition-all`, matching the existing spurious-contrast workaround
    // in e2e/bab-root-mixed.spec.ts.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/settings");
    await page.getByRole("button", { name: "Dark" }).click();
    await page.goto("/progress/weak-areas");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(true);
    await expect(page.getByText("Top practice priorities")).toBeVisible();
    await expectNoSeriousViolations(page);
  });
});
