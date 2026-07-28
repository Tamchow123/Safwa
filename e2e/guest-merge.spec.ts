import { chromium, type BrowserContext, type Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  E2E_PASSWORD,
  freshEmail,
  login,
  logout,
  registerAndVerify,
} from "./helpers/auth-flows";
import { expectNoSeriousViolations, settleAnimations } from "./helpers/axe";
import { bookmarksRowCount } from "./helpers/db-probe";
import { E2E_MAIN_BASE_URL } from "./helpers/e2e-server-env";
import { E2E_GUEST_OWNER_KEY, idbAll } from "./helpers/idb";
import { answerCorrectly, answerIncorrectly } from "./helpers/quiz";

/**
 * Phase 17 §26 — the guest→account merge, end to end.
 *
 * This is the Core MVP's last journey: someone studies without an account,
 * decides to keep it, registers, and finds their work waiting for them on the
 * account — on this device and on the next one. Everything below drives the
 * real UI against the real server; nothing is seeded into IndexedDB, because
 * the point of this suite is that history a learner ACTUALLY produced survives
 * the transition, and a seeded row proves only that a seeded row survives.
 *
 * WHAT THIS SUITE IS FOR that the unit and integration suites are not. The
 * server's rules (ownership, grading, idempotency, ceilings) are proved
 * deterministically in `tests/integration/guest-merge-*.test.ts`; the client
 * machine's twelve states are proved in
 * `modules/sync/client/guest-merge-machine.test.ts`. What only a browser can
 * show is that those pieces are wired to each other and to a learner: that the
 * prompt appears when there is something to merge and not otherwise, that
 * consent is required before anything leaves the device, that "Not now" costs
 * nothing, and that a second signed-in device sees the result. §26 also
 * requires the multi-context online-sync proof deferred in Phase 16 — it is
 * `26.1`'s second device, and it is not deferred again.
 *
 * Trace capture is disabled for the whole file, exactly as `auth.spec.ts` does
 * and for the same reason: these tests follow REAL verification links out of
 * the local outbox, and a CI retry would otherwise bundle a token-bearing URL
 * into an uploaded trace (§26, "no token-bearing auth URLs in traces").
 */
test.use({ trace: "off" });

/**
 * Desktop project only.
 *
 * Every test here builds real study history through the UI, registers, verifies
 * by email and merges — expensive work against a single dev server. Running the
 * whole suite a second time on the Pixel-7 project doubles that load without
 * adding coverage, and the contention is enough to time out unrelated specs
 * sharing the same server.
 *
 * §26's "mobile 320px journey" is a REQUIREMENT and is not skipped by this:
 * `26.5` sets a 320px viewport explicitly and asserts no horizontal scroll. It
 * tests the WIDTH, which is what the requirement is about — a user-agent string
 * is not what makes a layout break at 320px.
 */
test.skip(
  ({ isMobile }) => !!isMobile,
  "the merge journey runs on desktop; 26.5 covers 320px with an explicit viewport",
);

/** The merge dialog, identified by its state rather than by its prose. */
function mergeDialog(page: Page) {
  return page.getByTestId("guest-merge-dialog");
}

/** Wait for the merge flow to reach `name` (the machine's own state name). */
async function expectFlow(page: Page, name: string, timeout = 30_000) {
  await expect(mergeDialog(page)).toHaveAttribute("data-flow", name, {
    timeout,
  });
}

async function waitForLibrary(page: Page) {
  await expect(page.getByTestId("library-result-count")).toHaveText(
    /entries|matched/,
    { timeout: 15_000 },
  );
}

/**
 * Study up to `count` questions as the current identity, alternating right and
 * wrong so the resulting history is not uniform.
 *
 * Stops early if the session ends (the deck can run out before the count does),
 * because the assertions that matter read Dexie afterwards rather than trusting
 * anything this function reports about itself.
 */
async function studyQuestions(page: Page, count: number) {
  await page.goto("/study/mc");
  await expect(page.getByTestId("mc-quiz-session")).toBeVisible({
    timeout: 20_000,
  });
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) await answerCorrectly(page);
    else await answerIncorrectly(page);
    const next = page.getByTestId("mc-next");
    if (!(await next.isVisible())) break;
    await next.click();
    if (!(await page.getByTestId("mc-quiz-session").isVisible())) break;
  }
}

/** Bookmark the first Library entry. */
async function bookmarkFirstEntry(page: Page) {
  await page.goto("/library");
  await waitForLibrary(page);
  const toggle = page.getByTestId("bookmark-toggle").first();
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-bookmarked", "true");
}

/** Create an empty custom list with this name. */
async function createList(page: Page, name: string) {
  await page.goto("/library/saved");
  await page.getByRole("button", { name: "Create list" }).click();
  const dialog = page.getByTestId("create-list-dialog");
  await dialog.getByLabel("List name").fill(name);
  await dialog.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByRole("heading", { name, level: 3 })).toBeVisible();
}

/**
 * Reach Settings the way a learner does, by the nav link.
 *
 * `page.goto("/settings")` is a full page load, which restarts the merge
 * machine — and a restarted machine that still finds unmerged guest data asks
 * again rather than remembering that this visit already deferred. Both are
 * correct behaviours; only one of them leaves the deferred entry point on
 * screen, so a test about that entry point has to navigate within the app.
 */
async function goToSettings(page: Page) {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByTestId("export-my-data")).toBeVisible();
}

/** Change one guest setting to a non-default value. */
async function setGuestFontScale(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Large" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--arabic-font-scale"),
      ),
    )
    .toBe("1.2");
}

/** Every guest-owned row of a store, independent of app code. */
async function guestRows(page: Page, store: string) {
  const rows = (await idbAll(page, store)) as { ownerKey?: string }[];
  return rows.filter((row) => row.ownerKey === E2E_GUEST_OWNER_KEY);
}

/** Rows owned by any signed-in account. */
async function accountRows(page: Page, store: string) {
  const rows = (await idbAll(page, store)) as { ownerKey?: string }[];
  return rows.filter(
    (row) => typeof row.ownerKey === "string" && row.ownerKey !== "guest",
  );
}

/**
 * Produce a guest with real, non-trivial history: attempts of both outcomes, a
 * bookmark, a list and a changed setting. This is §26's steps 1-6.
 */
async function buildGuestHistory(page: Page, listName: string) {
  await page.goto("/");
  await expect(page.getByTestId("due-today-count")).toBeVisible({
    timeout: 20_000,
  });
  await studyQuestions(page, 4);
  await bookmarkFirstEntry(page);
  await createList(page, listName);
  await setGuestFontScale(page);

  // Real history exists before anything is merged — otherwise every assertion
  // afterwards could be satisfied by an empty account.
  expect((await guestRows(page, "study_attempts")).length).toBeGreaterThan(0);
  expect((await guestRows(page, "study_components")).length).toBeGreaterThan(0);
  expect((await guestRows(page, "bookmarks")).length).toBe(1);
}

test.describe("26.1 the Core MVP journey", () => {
  test("a guest's study, collections and settings follow them onto a new account, and onto a second device", async ({
    page,
  }) => {
    const email = freshEmail("merge-journey");
    const listName = "Journey list";
    const serverBookmarksBefore = await bookmarksRowCount();

    await buildGuestHistory(page, listName);
    const guestAttempts = (await guestRows(page, "study_attempts")).length;
    const guestComponents = (await guestRows(page, "study_components")).length;

    await registerAndVerify(page, email);
    await login(page, email);

    // 10-11: the prompt appears, and it says what will move BEFORE consent.
    await expectFlow(page, "ready-for-consent");
    const dialog = mergeDialog(page);
    await expect(dialog.getByText(/earlier progress/i)).toBeVisible();
    await expect(dialog.locator("dl")).toBeVisible();
    await settleAnimations(mergeDialog(page));
    await expectNoSeriousViolations(page);

    // Nothing has left the device yet: consent is what sends, not sign-in.
    // Asserted on the SERVER as well as locally, because "no account-owned
    // rows on this device" could in principle mean "the pull has not landed"
    // rather than "nothing was uploaded" — the server's own bookmark count
    // cannot be read that generously.
    expect(await bookmarksRowCount()).toBe(serverBookmarksBefore);
    expect(await accountRows(page, "study_attempts")).toEqual([]);

    // 12-13: consent, then an honest completed state.
    await dialog.getByRole("button", { name: "Add to my account" }).click();
    await expectFlow(page, "completed", 60_000);
    await settleAnimations(mergeDialog(page));
    await expectNoSeriousViolations(page);
    await dialog.getByRole("button", { name: "Continue studying" }).click();
    await expect(mergeDialog(page)).toHaveCount(0);

    // 14-15: the history is the account's now, and is no smaller than it was.
    await expect
      .poll(async () => (await accountRows(page, "study_attempts")).length, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(guestAttempts);
    expect(
      (await accountRows(page, "study_components")).length,
    ).toBeGreaterThanOrEqual(guestComponents);

    await page.goto("/library/saved");
    await expect(
      page.getByRole("heading", { name: listName, level: 3 }),
    ).toBeVisible();
    expect((await accountRows(page, "bookmarks")).length).toBeGreaterThan(0);
    // And it reached the SERVER — the same count that had to stay still before
    // consent must now have moved, or the merge only rearranged this device.
    await expect
      .poll(() => bookmarksRowCount(), { timeout: 30_000 })
      .toBeGreaterThan(serverBookmarksBefore);

    // 17-19: A SECOND DEVICE. This is the multi-context online-sync proof
    // deferred in Phase 16 (§26 forbids deferring it again): a genuinely
    // separate browser, separate profile, separate IndexedDB, that has never
    // seen this guest — so anything it shows came from the server.
    const browser = await chromium.launch();
    let second: BrowserContext | undefined;
    try {
      second = await browser.newContext({ baseURL: E2E_MAIN_BASE_URL });
      const secondPage = await second.newPage();
      await login(secondPage, email);
      await secondPage.goto("/");
      await expect(secondPage.getByTestId("due-today-count")).toBeVisible({
        timeout: 20_000,
      });

      // It starts empty of guest data by construction, so a non-zero account
      // count here can only have been pulled.
      expect(await guestRows(secondPage, "study_attempts")).toEqual([]);
      await expect
        .poll(
          async () =>
            (await accountRows(secondPage, "study_components")).length,
          { timeout: 60_000 },
        )
        .toBeGreaterThanOrEqual(guestComponents);

      await secondPage.goto("/library/saved");
      await expect(
        secondPage.getByRole("heading", { name: listName, level: 3 }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await second?.close();
      await browser.close();
    }
  });
});

test.describe("26.2 the merge is offered exactly when it is meaningful", () => {
  test("signing in with no guest data shows no prompt at all", async ({
    page,
  }) => {
    // A learner who registers on a clean device is not asked a question about
    // data that does not exist.
    const email = freshEmail("merge-none");
    await page.goto("/");
    await expect(page.getByTestId("due-today-count")).toBeVisible({
      timeout: 20_000,
    });
    await registerAndVerify(page, email);
    await login(page, email);
    await page.goto("/");
    await expect(page.getByTestId("due-today-count")).toBeVisible();
    await expect(mergeDialog(page)).toHaveCount(0);
  });

  test("re-running a finished merge changes nothing", async ({ page }) => {
    // Idempotency, seen from the learner's side: the second run reports that
    // there was nothing left to add rather than doubling their history.
    const email = freshEmail("merge-twice");
    await buildGuestHistory(page, "Twice list");
    await registerAndVerify(page, email);
    await login(page, email);

    await expectFlow(page, "ready-for-consent");
    await mergeDialog(page)
      .getByRole("button", { name: "Add to my account" })
      .click();
    await expectFlow(page, "completed", 60_000);
    await mergeDialog(page)
      .getByRole("button", { name: "Continue studying" })
      .click();

    const afterFirst = (await accountRows(page, "study_attempts")).length;
    expect(afterFirst).toBeGreaterThan(0);

    // The guest's copy is gone only NOW, after the account's copy is durable
    // (§9.5) — and that is what makes the second run a no-op rather than a
    // second import. Assert it, because it is the reason for everything below.
    expect(await guestRows(page, "study_attempts")).toEqual([]);

    // A reload is the second run: the machine restarts, re-reads the device,
    // and must find nothing left to offer. UNCONDITIONAL — an earlier version
    // wrapped this in `if (button.isVisible())`, which meant the correct
    // outcome (no button, because there is nothing to merge) silently skipped
    // the test's own point and asserted only that a count had not changed.
    await page.reload();
    await expect(page.getByTestId("due-today-count")).toBeVisible({
      timeout: 20_000,
    });
    await expect(mergeDialog(page)).toHaveCount(0);

    // Settings offers neither a fresh merge nor a retry: both would be an
    // invitation to import something that is no longer there.
    await goToSettings(page);
    await expect(page.getByTestId("merge-guest-data")).toHaveCount(0);
    await expect(page.getByTestId("retry-guest-merge")).toHaveCount(0);

    // And nothing was added by any of it.
    expect((await accountRows(page, "study_attempts")).length).toBe(afterFirst);
  });
});

test.describe("26.3 declining costs the learner nothing", () => {
  test('"Not now" uploads nothing, survives sign-out, and can be taken up later', async ({
    page,
  }) => {
    const email = freshEmail("merge-defer");
    await buildGuestHistory(page, "Deferred list");
    const guestAttempts = (await guestRows(page, "study_attempts")).length;

    await registerAndVerify(page, email);
    await login(page, email);
    await expectFlow(page, "ready-for-consent");
    await mergeDialog(page).getByRole("button", { name: "Not now" }).click();
    await expect(mergeDialog(page)).toHaveCount(0);

    // Nothing was sent. Declining is not a slower yes.
    expect(await accountRows(page, "study_attempts")).toEqual([]);

    // The deferred offer has a home: Settings carries it for the rest of the
    // visit, so changing your mind does not mean signing out and back in.
    // Reached by the nav LINK, not a fresh page load — the deferral is a fact
    // about this visit, and a reload is a new visit that asks again.
    await goToSettings(page);
    await expect(page.getByTestId("merge-guest-data")).toBeVisible();

    // And signing out keeps the guest's rows, which is what makes the offer
    // still meaningful later (§9.1) — Phase 16's wholesale wipe did not.
    // The reload asks again (a new visit, still-unmerged data); decline again
    // so the modal is not covering the account menu.
    await page.goto("/");
    await expectFlow(page, "ready-for-consent");
    await page.keyboard.press("Escape");
    await expect(mergeDialog(page)).toHaveCount(0);
    await logout(page);
    expect((await guestRows(page, "study_attempts")).length).toBe(
      guestAttempts,
    );

    // Taken up later: signing back in asks again, because the guest data is
    // still there and still unmerged. Declining once is not declining forever.
    await login(page, email);
    await expectFlow(page, "ready-for-consent");
    await mergeDialog(page)
      .getByRole("button", { name: "Add to my account" })
      .click();
    await expectFlow(page, "completed", 60_000);
    await expect
      .poll(async () => (await accountRows(page, "study_attempts")).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  });
});

test.describe("26.4 a merge that is interrupted is not a merge that is lost", () => {
  // The forced failure below is a deliberate network abort.
  test.use({ allowExpectedNetworkErrors: true });

  test("a failed upload offers a retry that survives a reload", async ({
    page,
  }) => {
    const email = freshEmail("merge-retry");
    await buildGuestHistory(page, "Retry list");
    await registerAndVerify(page, email);

    // Fail the merge request exactly once, then let everything through.
    let failed = false;
    await page.route("**/api/sync/guest-merge", async (route) => {
      if (!failed) {
        failed = true;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await login(page, email);
    await expectFlow(page, "ready-for-consent");
    await mergeDialog(page)
      .getByRole("button", { name: "Add to my account" })
      .click();
    await expectFlow(page, "retryable-error", 60_000);
    await settleAnimations(mergeDialog(page));
    await expectNoSeriousViolations(page);

    // The guest's data is untouched by the failure — nothing is deleted before
    // a durable completion.
    expect((await guestRows(page, "study_attempts")).length).toBeGreaterThan(0);

    // A learner who CLOSES the failure notice is not stranded: Settings carries
    // the retry for the rest of the visit. This is the recovery §19 asks for,
    // and it is a different control from the deferred-consent one because a
    // retry is not a fresh consent — part of the merge may already be durable.
    await page.keyboard.press("Escape");
    await expect(mergeDialog(page)).toHaveCount(0);
    await goToSettings(page);
    await expect(page.getByTestId("retry-guest-merge")).toBeVisible();

    // And a RELOAD in the middle of a retryable stage loses nothing either.
    // The machine restarts from what is actually on the device, finds the guest
    // data still unmerged, and asks again — which is the property that matters:
    // an interrupted merge costs the learner a second consent, never history.
    await page.reload();
    await expectFlow(page, "ready-for-consent", 60_000);
    expect((await guestRows(page, "study_attempts")).length).toBeGreaterThan(0);
    await mergeDialog(page)
      .getByRole("button", { name: "Add to my account" })
      .click();
    await expectFlow(page, "completed", 60_000);
    await expect
      .poll(async () => (await accountRows(page, "study_attempts")).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  });
});

test.describe("26.5 the merge on a small screen and from the keyboard", () => {
  test("the journey holds at 320px with no horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const email = freshEmail("merge-mobile");
    await buildGuestHistory(page, "Mobile list");
    await registerAndVerify(page, email);
    await login(page, email);

    await expectFlow(page, "ready-for-consent");
    await expectNoHorizontalOverflow(page);
    await settleAnimations(mergeDialog(page));
    await expectNoSeriousViolations(page);

    await mergeDialog(page)
      .getByRole("button", { name: "Add to my account" })
      .click();
    await expectFlow(page, "completed", 60_000);
    await expectNoHorizontalOverflow(page);
    await settleAnimations(mergeDialog(page));
    await expectNoSeriousViolations(page);
  });

  test("consent can be given without a pointer, and Escape means Not now", async ({
    page,
  }) => {
    const email = freshEmail("merge-keyboard");
    await buildGuestHistory(page, "Keyboard list");
    await registerAndVerify(page, email);
    await login(page, email);
    await expectFlow(page, "ready-for-consent");

    // Escape on the CONSENT prompt is a decline, not an accept — the
    // non-destructive answer, exactly as the "Not now" button gives (§9.1).
    await page.keyboard.press("Escape");
    await expect(mergeDialog(page)).toHaveCount(0);
    expect(await accountRows(page, "study_attempts")).toEqual([]);

    // Bring it back from Settings and drive the whole consent with the
    // keyboard alone.
    await goToSettings(page);
    await page.getByTestId("merge-guest-data").click();
    await expectFlow(page, "ready-for-consent");

    const consent = mergeDialog(page).getByRole("button", {
      name: "Add to my account",
    });
    await consent.focus();
    await expect(consent).toBeFocused();
    await page.keyboard.press("Enter");
    await expectFlow(page, "completed", 60_000);

    // A running merge refuses Escape: closing would suggest it stopped.
    const done = mergeDialog(page).getByRole("button", {
      name: "Continue studying",
    });
    await done.focus();
    await page.keyboard.press("Enter");
    await expect(mergeDialog(page)).toHaveCount(0);
  });
});

/** No axis of the page may scroll sideways at the current viewport. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("26.6 the merge surface in dark mode", () => {
  test("the consent prompt passes an axe scan in the dark theme", async ({
    page,
  }) => {
    const email = freshEmail("merge-dark");
    await buildGuestHistory(page, "Dark list");
    await page.goto("/");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await registerAndVerify(page, email);
    await login(page, email);
    await expectFlow(page, "ready-for-consent");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await settleAnimations(mergeDialog(page));
    await expectNoSeriousViolations(page);
  });
});

test.describe("26.7 nothing leaks into what CI uploads", () => {
  test("no auth token appears in client-readable storage after the merge", async ({
    page,
  }) => {
    // The merge writes import metadata locally. §30 forbids secrets or auth
    // tokens ever being among it — a token in IndexedDB would survive every
    // logout path that only clears cookies.
    const email = freshEmail("merge-no-token");
    await buildGuestHistory(page, "Token list");
    await registerAndVerify(page, email);
    await login(page, email);
    await expectFlow(page, "ready-for-consent");
    await mergeDialog(page)
      .getByRole("button", { name: "Add to my account" })
      .click();
    await expectFlow(page, "completed", 60_000);

    const storage = await page.evaluate(() => ({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
    }));
    // The PHYSICAL store name — `helpers/idb.ts` maps only the four stores
    // schema v7 renamed, and this is not one of them.
    const imports = await idbAll(page, "guest_imports");

    // Every surface this requirement names, checked the SAME two ways. The
    // word search is a cheap regression guard on field NAMES; the real
    // assertion is the one below it, because a credential stored under an
    // innocent-looking key passes a word search and is still a credential.
    const surfaces = {
      "web storage": JSON.stringify(storage),
      "merge import metadata": JSON.stringify(imports),
    };
    for (const [where, dump] of Object.entries(surfaces)) {
      expect(dump, `${where} names no credential`).not.toMatch(
        /token|secret|password/i,
      );
    }

    // The session cookie's ACTUAL value must appear in none of them. This is
    // what catches a real leak under a field name nobody thought to forbid —
    // and a token in IndexedDB would survive every logout path that only
    // clears cookies (§30).
    const cookies = await page.context().cookies();
    const sessionCookies = cookies.filter((cookie) =>
      cookie.name.includes("session_token"),
    );
    // Guard the guard: with no session cookie the loop below asserts nothing.
    expect(sessionCookies.length).toBeGreaterThan(0);
    for (const cookie of sessionCookies) {
      for (const [where, dump] of Object.entries(surfaces)) {
        expect(
          dump,
          `${where} does not contain the session token`,
        ).not.toContain(cookie.value);
      }
    }
  });
});

test.describe("26.8 the account keeps its own settings", () => {
  test("a merge does not overwrite settings the account already had", async ({
    page,
  }) => {
    // Account-wins semantics (§16): the merge unions collections but must not
    // let a guest's preference silently replace one the learner set while
    // signed in. Proved through the value the account chose LAST.
    const email = freshEmail("merge-settings");
    await buildGuestHistory(page, "Settings list");
    await registerAndVerify(page, email);
    await login(page, email);
    await expectFlow(page, "ready-for-consent");

    // Guest chose Large; the account now chooses Small, before merging.
    await mergeDialog(page).getByRole("button", { name: "Not now" }).click();
    await goToSettings(page);
    await page.getByRole("button", { name: "Small" }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--arabic-font-scale",
          ),
        ),
      )
      .not.toBe("1.2");

    await page.getByTestId("merge-guest-data").click();
    await expectFlow(page, "ready-for-consent");
    await mergeDialog(page)
      .getByRole("button", { name: "Add to my account" })
      .click();
    await expectFlow(page, "completed", 60_000);
    await mergeDialog(page)
      .getByRole("button", { name: "Continue studying" })
      .click();

    // The account's own choice stands.
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: "Small" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("26.9 guest data is never destroyed by a refusal", () => {
  test("a rejected merge leaves every guest row where it was", async ({
    page,
  }) => {
    // An unverified account cannot merge (§13). The refusal must be explained
    // and must cost nothing — the guest's history is the only copy.
    const email = freshEmail("merge-unverified");
    await buildGuestHistory(page, "Unverified list");
    const before = (await guestRows(page, "study_attempts")).length;

    await page.goto("/register");
    await page.getByLabel("Name").fill("Unverified Learner");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByTestId("register-verification-notice"),
    ).toBeVisible();

    // Never signed in, so no merge is offered and nothing is touched.
    await page.goto("/");
    await expect(page.getByTestId("due-today-count")).toBeVisible({
      timeout: 20_000,
    });
    await expect(mergeDialog(page)).toHaveCount(0);
    expect((await guestRows(page, "study_attempts")).length).toBe(before);
  });
});
