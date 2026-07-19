import type { Page } from "@playwright/test";

import { deriveAllComponents } from "../modules/study-engine/components";
import { expect, test } from "./fixtures";
import { expectNoSeriousViolations } from "./helpers/axe";
import { loadLearnerRelease } from "./helpers/learner-release";

/**
 * Phase 12 dashboard & progress E2E (§26): new-guest zero state, the real
 * study-then-dashboard happy path (actual guest persistence — never
 * UI-only seeding), incorrect-attempt streak honesty, undo refunds,
 * timezone-change immutability, a DST streak fixture, due-today counting,
 * daily-target settings, the 320px mobile journey and axe on every state.
 *
 * Fixture provenance: the due-today fixture's component keys are derived
 * programmatically from the loaded learner release (never hand-typed or
 * invented); the DST/populated-axe fixtures only need valid study-attempt
 * rows with correct immutable local dates — no component lookup is
 * exercised — so their componentKeys are synthetic placeholders.
 *
 * Date-sensitive tests that study and then read the dashboard assume they
 * do not straddle local midnight mid-test (a ~1-in-1440 window); CI's
 * retry policy re-anchors both steps to the same day. The due-today test
 * is fully deterministic by construction instead (see §26.7).
 */

const DB_NAME = "safwa-content";

/** Read all rows of an app IndexedDB store, independent of app code. */
function idbAll(page: Page, store: string): Promise<unknown[]> {
  return page.evaluate(
    async ({ dbName, store }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) return [];
        return await new Promise<unknown[]>((resolve, reject) => {
          const request = database
            .transaction(store, "readonly")
            .objectStore(store)
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, store },
  );
}

/** Put rows into an app IndexedDB store (schema must already exist). */
function idbSeed(
  page: Page,
  store: string,
  rows: readonly unknown[],
): Promise<void> {
  return page.evaluate(
    async ({ dbName, store, rows }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) {
          throw new Error(
            `idbSeed: store "${store}" not found — navigate to the app first so its schema exists`,
          );
        }
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(store, "readwrite");
          const objectStore = transaction.objectStore(store);
          for (const row of rows) objectStore.put(row);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, store, rows },
  );
}

/** The dd value that follows an exact-matching dt in a summary list. */
function statValue(page: Page, label: RegExp) {
  return page
    .locator("dt")
    .filter({ hasText: label })
    .locator("xpath=following-sibling::dd[1]");
}

/** Click the correct option for the current MC question. */
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

/** Click a wrong option for the current MC question. */
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

/** Set questions/session to 1 so a session is a single scheduling attempt. */
async function setSingleQuestionSessions(page: Page) {
  await page.goto("/settings");
  const input = page.getByTestId("study-default-questionCount");
  await expect(input).toBeEnabled();
  await input.fill("1");
  await page.getByTestId("study-defaults-save").click();
  await expect(page.getByText("Study defaults saved")).toBeVisible();
}

/** No horizontal overflow: the page must not scroll sideways (§20). */
async function expectNoHorizontalOverflow(page: Page, width: number) {
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

/** Three derivable essential component keys from distinct entries. */
function derivableKeys(count: number): string[] {
  const derived = deriveAllComponents(loadLearnerRelease().entries);
  const keys: string[] = [];
  const usedEntries = new Set<number>();
  for (const component of derived) {
    if (!component.essential || usedEntries.has(component.entryId)) continue;
    usedEntries.add(component.entryId);
    keys.push(component.key);
    if (keys.length === count) return keys;
  }
  throw new Error("not enough derivable essential components");
}

/** A card row for seeding (usable FSRS shape, review state). */
function seedCard(dueAtMs: number) {
  return {
    stability: 10,
    difficulty: 5,
    dueAtMs,
    state: "review",
    reps: 3,
    lapses: 0,
    scheduledDays: 10,
    learningSteps: 0,
    lastReviewAtMs: dueAtMs - 10 * 86_400_000,
  };
}

/** A valid stored attempt row for a given immutable local date. */
function seedAttemptRow(id: string, localDate: string) {
  return {
    id,
    componentKey: `seed:${id}`,
    sessionId: "seed-session",
    attemptedAt: Date.now(),
    attempt: {
      localDateAtEvent: localDate,
      responseTimeMs: 1500,
    },
  };
}

test.describe("new guest dashboard (§26.1)", () => {
  test("honest zero state with working actions, axe-clean", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Dashboard",
    );
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await expect(statValue(page, /^Current streak$/)).toHaveText("0 days");
    await expect(statValue(page, /^Study time today$/)).toHaveText("0 min");
    await expect(page.getByTestId("due-today-count")).toHaveText("0");
    // Daily targets reflect the current saved defaults (10 new · 20 reviews).
    await expect(page.getByText("0 of 10")).toBeVisible();
    await expect(page.getByText("0 of 20")).toBeVisible();
    await expect(page.getByTestId("trend-empty")).toBeVisible();
    await expectNoSeriousViolations(page);

    // Start studying is the primary action and actually navigates.
    await page.getByRole("link", { name: "Start studying" }).click();
    await expect(page).toHaveURL(/\/study$/);
  });

  test("no horizontal overflow at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/");
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, 320);
  });
});

test.describe("study updates the dashboard (§26.2)", () => {
  test("a real first attempt updates streak, time, targets and progress", async ({
    page,
  }) => {
    // The primary happy path exercises the REAL study persistence path —
    // no seeded UI state anywhere in this test. The bāb quiz is used
    // because a bāb component is ALWAYS essential, so exactly one word
    // deterministically moves out of "not started" (the MC quiz can draw
    // an extended component whose attempt never changes word states).
    await page.goto("/study/bab");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-next")).toBeVisible();

    await page.goto("/");
    await expect(statValue(page, /^Current streak$/)).toHaveText("1 day");
    await expect(statValue(page, /^Study time today$/)).not.toHaveText("0 min");
    // The DASHBOARD's own word-state counts move (§26.2 step 4) — one word
    // out of "not started" into learning.
    await expect(statValue(page, /^Learning$/)).toHaveText("1");
    await expect(statValue(page, /^Not started$/)).toHaveText("454");
    // The first attempt on a new component consumes the new-items target.
    await expect(page.getByText("1 of 10")).toBeVisible();
    // Today's activity appears in the trend with the exact attempt count.
    await expect(page.locator('[data-date][data-attempts="1"]')).toHaveCount(1);

    // The detailed Progress page reflects the same derivation: one word
    // has moved out of "not started"…
    await page.goto("/progress");
    await expect(statValue(page, /^Started$/)).toHaveText("1");
    await expect(statValue(page, /^Learning$/)).toHaveText("1");
    await expect(statValue(page, /^Not started$/)).toHaveText("454");
    // The per-skill MASTERY numerator honestly stays 0 after one attempt
    // (mastery needs ≥3 distinct qualifying days) — the exact ratio is
    // asserted so a fake increment would fail here.
    const babSkill = page.getByRole("progressbar", {
      name: "Bāb identification",
    });
    await expect(babSkill).toHaveAttribute("aria-valuemax", "455");
    await expect(babSkill).toHaveAttribute("aria-valuenow", "0");
  });

  test("the per-skill numerator tracks the specific skill dimension (seeded)", async ({
    page,
  }) => {
    // §26.2 step 6's discriminating check: a MASTERED bāb component must
    // move exactly the bāb-identification numerator and no other skill's —
    // word states alone cannot catch a mis-attributed skill tally. Mastery
    // cannot be reached in one real session (≥3 distinct days), so this
    // check seeds the component state directly.
    const babKey = deriveAllComponents(loadLearnerRelease().entries).find(
      (component) => component.skillType === "bab_identification",
    )!;
    await page.goto("/");
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await idbSeed(page, "study_components", [
      {
        componentKey: babKey.key,
        entryId: babKey.entryId,
        learnerState: "mastered",
        fsrs: seedCard(Date.now() + 30 * 86_400_000),
      },
    ]);
    await page.goto("/progress");
    await expect(
      page.getByRole("progressbar", { name: "Bāb identification" }),
    ).toHaveAttribute("aria-valuenow", "1");
    // No leakage into a different skill dimension.
    await expect(
      page.getByRole("progressbar", { name: "Root identification" }),
    ).toHaveAttribute("aria-valuenow", "0");
  });
});

test.describe("incorrect attempt (§26.3)", () => {
  test("an incorrect first attempt counts for streak/activity but reinforcement never double-consumes", async ({
    page,
  }) => {
    await setSingleQuestionSessions(page);
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerIncorrectly(page);
    await page.getByTestId("mc-next").click();

    // The reinforcement re-ask follows (single-question session): answer it
    // correctly and finish.
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await page.getByTestId("mc-next").click();
    await expect(page.getByTestId("mc-results")).toBeVisible();

    await page.goto("/");
    // The incorrect day still counts toward the streak.
    await expect(statValue(page, /^Current streak$/)).toHaveText("1 day");
    // Both attempts (first + reinforcement) appear as activity…
    await expect(page.locator('[data-date][data-attempts="2"]')).toHaveCount(1);
    // …but the scheduling target was consumed exactly ONCE: reinforcement
    // creates no second scheduling event.
    await expect(page.getByText("1 of 10")).toBeVisible();
  });
});

test.describe("undo refunds (§26.4)", () => {
  test("undoing the attempt refunds the target and activity", async ({
    page,
    context,
  }) => {
    await setSingleQuestionSessions(page);
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-next")).toBeVisible();

    // Verify consumed target in a second tab so the session stays alive.
    const dashboard = await context.newPage();
    try {
      await dashboard.goto("/");
      await expect(dashboard.getByText("1 of 10")).toBeVisible();
      await expect(statValue(dashboard, /^Current streak$/)).toHaveText(
        "1 day",
      );

      // Undo through the supported session UI path.
      await page.getByTestId("undo").click();
      await expect(page.getByTestId("undo")).toBeDisabled();

      await dashboard.reload();
      await expect(dashboard.getByText("0 of 10")).toBeVisible();
      await expect(statValue(dashboard, /^Current streak$/)).toHaveText(
        "0 days",
      );
      await expect(dashboard.getByTestId("trend-empty")).toBeVisible();
    } finally {
      await dashboard.close();
    }
  });
});

test.describe("timezone change (§26.5)", () => {
  test.use({ timezoneId: "America/New_York" });

  test("history keeps its stored zone/date; new attempts use the user setting", async ({
    page,
  }) => {
    await setSingleQuestionSessions(page);

    // Attempt 1 in browser-detected mode.
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-next")).toBeVisible();

    type StoredAttempt = {
      attemptedAt: number;
      attempt?: {
        timezoneAtEvent?: string;
        timezoneSource?: string;
        localDateAtEvent?: string;
      };
    };
    const before = (await idbAll(page, "study_attempts")) as StoredAttempt[];
    expect(before).toHaveLength(1);
    expect(before[0].attempt?.timezoneAtEvent).toBe("America/New_York");
    expect(before[0].attempt?.timezoneSource).toBe("browser_detected");
    const firstStoredDate = before[0].attempt?.localDateAtEvent;
    expect(firstStoredDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Save a different supported IANA zone (picked from the select's own
    // programmatic option list — never a hand-maintained value).
    await page.goto("/settings");
    const select = page.getByTestId("timezone-select");
    await expect(select).toBeVisible();
    await expect(select.locator('option[value="Asia/Tokyo"]')).toHaveCount(1);
    await select.selectOption("Asia/Tokyo");
    await expect
      .poll(async () => {
        const rows = (await idbAll(page, "settings")) as {
          key: string;
          value?: { mode?: string; timezone?: string };
        }[];
        return rows.find((row) => row.key === "timezone")?.value ?? null;
      })
      .toEqual({ mode: "iana", timezone: "Asia/Tokyo" });

    // Attempt 2 in a NEW session under the user-set zone.
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-next")).toBeVisible();

    const after = (await idbAll(page, "study_attempts")) as StoredAttempt[];
    expect(after).toHaveLength(2);
    const sorted = [...after].sort((a, b) => a.attemptedAt - b.attemptedAt);
    // The old attempt was NEVER re-keyed: zone, source and date unchanged.
    expect(sorted[0].attempt?.timezoneAtEvent).toBe("America/New_York");
    expect(sorted[0].attempt?.timezoneSource).toBe("browser_detected");
    expect(sorted[0].attempt?.localDateAtEvent).toBe(firstStoredDate);
    // The new attempt carries the selected zone with the honest source.
    expect(sorted[1].attempt?.timezoneAtEvent).toBe("Asia/Tokyo");
    expect(sorted[1].attempt?.timezoneSource).toBe("user_setting");

    // Dashboard activity keys on the immutable STORED dates.
    await page.goto("/");
    await expect(
      page.locator(`[data-date="${firstStoredDate}"]`),
    ).toHaveAttribute("data-attempts", /^[12]$/);
  });
});

test.describe("DST streak fixture (§26.6)", () => {
  test("consecutive stored dates across a DST transition count as one run", async ({
    page,
  }) => {
    // 2026-03-08 is the US spring-forward date (a 23-hour local day):
    // label-based date arithmetic must still see 07→08→09 as consecutive.
    await page.goto("/");
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await idbSeed(page, "study_attempts", [
      seedAttemptRow("dst-1", "2026-03-07"),
      seedAttemptRow("dst-2", "2026-03-08"),
      seedAttemptRow("dst-3", "2026-03-09"),
    ]);
    await page.goto("/progress");
    await expect(statValue(page, /^Longest streak$/)).toHaveText("3 days");
    // Real history outside the 30-day window is NEVER "No activity yet"
    // (that would contradict the streak shown above): every zero bar stays
    // represented with the honest window-scoped note instead. Unlike §26.7
    // (which pins timezoneId: "UTC" and anchors instants off Date.now()),
    // this relies on the REAL wall clock being more than 30 days past the
    // fixed 2026-03 fixture dates — true for the lifetime of this suite,
    // since real time only advances — rather than a mocked/frozen clock. If
    // these fixture dates are ever moved to a later DST transition, re-check
    // this assumption.
    await expect(page.getByTestId("trend-empty")).toHaveCount(0);
    await expect(page.locator("[data-date]")).toHaveCount(30);
    await expect(page.getByTestId("trend-window-empty")).toHaveText(
      "No attempts in the last 30 days.",
    );
  });
});

test.describe("due today (§26.7)", () => {
  // The effective zone is pinned to UTC so the fixture instants below can
  // be anchored to UTC calendar dates, making the expected count correct
  // under EVERY possible timing — including a midnight rollover mid-test.
  test.use({ timezoneId: "UTC" });

  test("only overdue and later-today cards count; tomorrow and stale rows never do", async ({
    page,
  }) => {
    const [overdueKey, laterTodayKey, tomorrowKey] = derivableKeys(3);
    // Entry 369's root is quiz-ineligible, so its root component is NOT
    // derivable from the release — the canonical stale/ineligible row.
    const staleKey = "entry:369:skill:root_identification";
    const derivedKeys = new Set(
      deriveAllComponents(loadLearnerRelease().entries).map(
        (component) => component.key,
      ),
    );
    expect(derivedKeys.has(staleKey)).toBe(false);

    await page.goto("/");
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    // Timing-proof anchors (all in UTC, the pinned effective zone):
    //  - later today = 23:59 of the CURRENT UTC day — still counts as due
    //    even if the day rolls over before the assertion (it merely becomes
    //    overdue, which also counts);
    //  - tomorrow    = midnight of the day AFTER next — still excluded even
    //    after a single rollover;
    //  - overdue     = an hour ago — today or yesterday, counts either way.
    const now = new Date();
    const laterTodayMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      0,
    );
    const tomorrowMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 2,
    );
    await idbSeed(page, "study_components", [
      {
        componentKey: overdueKey,
        entryId: Number(overdueKey.split(":")[1]),
        learnerState: "learning",
        fsrs: seedCard(now.getTime() - 3_600_000),
      },
      {
        componentKey: laterTodayKey,
        entryId: Number(laterTodayKey.split(":")[1]),
        learnerState: "learning",
        fsrs: seedCard(laterTodayMs),
      },
      {
        componentKey: tomorrowKey,
        entryId: Number(tomorrowKey.split(":")[1]),
        learnerState: "learning",
        fsrs: seedCard(tomorrowMs),
      },
      {
        componentKey: staleKey,
        entryId: 369,
        learnerState: "learning",
        fsrs: seedCard(now.getTime() - 3_600_000),
      },
    ]);
    await page.reload();
    await expect(page.getByTestId("due-today-count")).toHaveText("2");
  });
});

test.describe("daily target settings (§26.8)", () => {
  test("changing targets updates denominators without rewriting history", async ({
    page,
  }) => {
    await page.goto("/study/mc");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-next")).toBeVisible();

    await page.goto("/");
    await expect(page.getByText("1 of 10")).toBeVisible();

    await page.goto("/settings");
    const newPerDay = page.getByTestId("study-default-newPerDay");
    await expect(newPerDay).toBeEnabled();
    await newPerDay.fill("7");
    const reviewsPerDay = page.getByTestId("study-default-reviewsPerDay");
    await reviewsPerDay.fill("9");
    await page.getByTestId("study-defaults-save").click();
    await expect(page.getByText("Study defaults saved")).toBeVisible();

    await page.goto("/");
    // The numerator (today's real history) is unchanged; only the
    // denominators moved.
    await expect(page.getByText("1 of 7")).toBeVisible();
    await expect(page.getByText("0 of 9")).toBeVisible();
  });
});

test.describe("mobile guest journey (§26.9)", () => {
  test("the full 320px journey stays reachable with no overflow", async ({
    page,
  }) => {
    // Six navigations across five routes — first visits pay dev-server
    // compile cost, so give this journey extra timeout headroom.
    test.slow();
    await page.setViewportSize({ width: 320, height: 720 });

    await page.goto("/");
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, 320);

    await page.getByRole("link", { name: "Start studying" }).click();
    await expect(page).toHaveURL(/\/study$/);
    // The bāb quiz keeps the word-state assertion deterministic (always an
    // essential component; see §26.2).
    await page.goto("/study/bab");
    await expect(page.getByTestId("mc-quiz-session")).toBeVisible();
    await answerCorrectly(page);
    await expect(page.getByTestId("mc-next")).toBeVisible();

    await page.goto("/");
    await expect(statValue(page, /^Current streak$/)).toHaveText("1 day");
    await expectNoHorizontalOverflow(page, 320);

    await page.goto("/progress");
    await expect(statValue(page, /^Started$/)).toHaveText("1");
    await expectNoHorizontalOverflow(page, 320);

    await page.goto("/settings");
    const select = page.getByTestId("timezone-select");
    await expect(select).toBeVisible();
    await select.selectOption("UTC");
    await expect
      .poll(async () => {
        const rows = (await idbAll(page, "settings")) as {
          key: string;
          value?: { mode?: string; timezone?: string };
        }[];
        return rows.find((row) => row.key === "timezone")?.value ?? null;
      })
      .toEqual({ mode: "iana", timezone: "UTC" });
    await expectNoHorizontalOverflow(page, 320);
  });
});

test.describe("accessibility (§26.10)", () => {
  test("empty dashboard, progress and timezone settings pass axe", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.goto("/progress");
    await expect(statValue(page, /^Started$/)).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.goto("/settings");
    await expect(page.getByTestId("timezone-select")).toBeVisible();
    await expect(page.getByTestId("study-defaults-save")).toBeEnabled();
    await expect(page.getByTestId("study-defaults-save")).toHaveCSS(
      "opacity",
      "1",
    );
    await expectNoSeriousViolations(page);
  });

  test("populated dashboard passes axe (light, dark and 320px)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await idbSeed(page, "study_attempts", [
      seedAttemptRow("axe-1", "2026-03-07"),
      seedAttemptRow("axe-2", "2026-03-08"),
    ]);
    await page.reload();
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.setViewportSize({ width: 320, height: 720 });
    await expectNoSeriousViolations(page);
    await expectNoHorizontalOverflow(page, 320);

    // Dark mode through the app's own durable theme setting.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/settings");
    await page.getByRole("button", { name: "Dark" }).click();
    await page.goto("/");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(true);
    await expect(page.getByText(/0 of 455/).first()).toBeVisible();
    await expectNoSeriousViolations(page);
  });
});
