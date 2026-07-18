import AxeBuilder from "@axe-core/playwright";
import type { CDPSession, Page } from "@playwright/test";

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

/** The device profile row, or null if none has been written. */
function idbProfile(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("profile")) return null;
      return await new Promise((resolve, reject) => {
        const request = database
          .transaction("profile", "readonly")
          .objectStore("profile")
          .get("device");
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/** All stored review-event ids. */
function idbEventIds(page: Page): Promise<string[]> {
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
          .getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

/** Flip the current card (Space on the focused card button); retries to absorb
 * the occasional missed key event without double-toggling. */
async function flip(page: Page) {
  const card = page.getByTestId("flashcard");
  for (let attempt = 0; attempt < 3; attempt++) {
    await card.focus();
    await page.keyboard.press("Space");
    try {
      // Wait for THIS press to register before deciding to retry, so a slow
      // update is never mistaken for a miss (which would press again and unflip).
      await expect(card).toHaveAttribute("data-flipped", "true", {
        timeout: 500,
      });
      return;
    } catch {
      // Missed key event — try again.
    }
  }
  await expect(card).toHaveAttribute("data-flipped", "true");
}

/**
 * Reveal the current card with a REAL browser tap via the CDP touch protocol
 * (touchStart + touchEnd at the card centre → a synthesized click that flips the
 * card). Retries once to absorb touch-pipeline timing. Requires touch emulation
 * (the mobile project).
 */
async function realTouchTap(client: CDPSession, page: Page) {
  const card = page.getByTestId("flashcard");
  const box = await card.boundingBox();
  if (!box) throw new Error("no flashcard bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  for (let attempt = 0; attempt < 2; attempt++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    if ((await card.getAttribute("data-flipped")) === "true") return;
    await page.waitForTimeout(50);
  }
  await expect(card).toHaveAttribute("data-flipped", "true");
}

/**
 * Drive a REAL browser touch swipe across the card via the CDP touch protocol
 * (touchStart → moves → touchEnd at screen coordinates) — full hit-testing and
 * gesture arbitration, not synthetic event dispatch. Requires touch emulation
 * (the mobile project). Rightward = "I know", leftward = "I don't know".
 */
async function realTouchSwipe(
  client: CDPSession,
  page: Page,
  direction: "left" | "right",
) {
  const box = await page.getByTestId("flashcard").boundingBox();
  if (!box) throw new Error("no flashcard bounding box");
  const y = box.y + box.height / 2;
  const startX =
    direction === "right" ? box.x + box.width * 0.2 : box.x + box.width * 0.8;
  const endX =
    direction === "right" ? box.x + box.width * 0.9 : box.x + box.width * 0.1;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: startX, y }],
  });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: startX + ((endX - startX) * i) / steps, y }],
    });
  }
  // touchEnd carries no points; Chrome reconstructs changedTouches at the last
  // moved position, which the React onTouchEnd handler reads to compute dx.
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

/** All stored study_components (componentKey + learnerState + whether it has an FSRS card). */
function idbComponents(
  page: Page,
): Promise<{ key: string; state?: string; hasCard: boolean }[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("safwa-content");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("study_components")) return [];
      return await new Promise<
        { key: string; state?: string; hasCard: boolean }[]
      >((resolve, reject) => {
        const request = database
          .transaction("study_components", "readonly")
          .objectStore("study_components")
          .getAll();
        request.onsuccess = () =>
          resolve(
            (
              request.result as {
                componentKey: string;
                learnerState?: string;
                fsrs?: unknown;
              }[]
            ).map((row) => ({
              key: row.componentKey,
              state: row.learnerState,
              hasCard: row.fsrs !== undefined,
            })),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

test.describe("flashcards", () => {
  test("a guest reaches the first flashcard in 2 taps from landing", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/");
    const nav = isMobile
      ? page.getByTestId("mobile-nav")
      : page.getByTestId("app-sidebar");

    // Tap 1: Study. Tap 2: Start flashcards.
    await nav.getByRole("link", { name: "Study" }).click();
    await page.getByTestId("start-flashcards").click();

    // The first card is visible with no further interaction.
    await expect(page.getByTestId("flashcard")).toBeVisible();
    await expect(page.getByText(/Card 1 of/)).toBeVisible();
  });

  test("merely viewing flashcards writes no durable identity (lazy profile)", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();
    // No grading yet: init is read-only, so no profile row exists and the
    // register prompt (which keys off a durable profile) does not surface.
    expect(await idbProfile(page)).toBeNull();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Dashboard",
    );
    await expect(page.getByTestId("register-prompt")).toHaveCount(0);
  });

  test("keyboard-only: flip and rate persist an attempt and a scheduling event", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();

    // Ratings are gated until the answer is revealed.
    await expect(page.getByTestId("rate-know")).toBeDisabled();
    await flip(page);
    await expect(page.getByTestId("rate-know")).toBeEnabled();

    // Rate with the keyboard (→ = "I know").
    await page.getByTestId("flashcard").focus();
    await page.keyboard.press("ArrowRight");

    await expect(page.getByText(/Card 2 of/)).toBeVisible();
    await expect.poll(() => idbCount(page, "study_attempts")).toBe(1);
    await expect.poll(() => idbCount(page, "review_events")).toBe(1);
    expect(await idbRatings(page)).toEqual(["good"]);
    // Event ids are client-generated UUIDv7 (DATA_MODEL §6): version nibble = 7.
    const eventIds = await idbEventIds(page);
    expect(eventIds).toHaveLength(1);
    for (const id of eventIds) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  test("undo removes exactly the last attempt and its event, once", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();
    await expect(page.getByTestId("undo")).toBeDisabled();

    await flip(page);
    await page.getByTestId("rate-know").click();
    await expect(page.getByText(/Card 2 of/)).toBeVisible();
    await expect.poll(() => idbCount(page, "review_events")).toBe(1);

    await page.getByTestId("undo").click();
    await expect(page.getByText(/Card 1 of/)).toBeVisible();
    await expect.poll(() => idbCount(page, "study_attempts")).toBe(0);
    await expect.poll(() => idbCount(page, "review_events")).toBe(0);
    // Single-step: no second undo.
    await expect(page.getByTestId("undo")).toBeDisabled();
  });

  test("a wrong answer is re-queued and creates an Again event", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();
    const totalText = await page.getByText(/Card 1 of/).textContent();
    const total = Number(/Card 1 of (\d+)/.exec(totalText!)![1]);

    await flip(page);
    await page.getByTestId("rate-dont-know").click();

    // The plan grows by one reinforcement item (re-queued to the end), and the
    // wrong first attempt persists exactly one Again scheduling event. (That the
    // later reinforcement recovery creates NO second event is covered by the
    // persistence unit tests.)
    await expect(
      page.getByText(new RegExp(`Card 2 of ${total + 1}`)),
    ).toBeVisible();
    await expect.poll(() => idbCount(page, "study_attempts")).toBe(1);
    await expect.poll(() => idbCount(page, "review_events")).toBe(1);
    expect(await idbRatings(page)).toEqual(["again"]);
  });

  test("completes a full keyboard-only session to the summary", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();

    // Answer every card "I know" (no re-queue) until the summary appears.
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("session-summary").isVisible()) break;
      await flip(page);
      await page.getByTestId("flashcard").focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(20);
    }

    await expect(page.getByTestId("session-summary")).toBeVisible();
    // Every graded first attempt persisted an attempt and an event.
    const attempts = await idbCount(page, "study_attempts");
    const events = await idbCount(page, "review_events");
    expect(attempts).toBeGreaterThan(0);
    // An all-"I know" run never re-queues, so every attempt is a first attempt
    // and produces exactly one scheduling event.
    expect(events).toBe(attempts);
    // Each reviewed component now has an FSRS card and a projected state.
    const components = await idbComponents(page);
    expect(components.length).toBe(events);
    for (const component of components) {
      expect(component.hasCard).toBe(true);
      expect(["learning", "mastered", "needs_review"]).toContain(
        component.state,
      );
    }
  });

  test("wrong-then-correct: the reinforcement recovery adds an attempt but no event", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();

    // Fail the very first card, then clear the rest (and its re-queued
    // reinforcement) with "I know" until the summary.
    await flip(page);
    await page.getByTestId("rate-dont-know").click();
    await expect(page.getByText(/Card 2 of/)).toBeVisible();

    for (let i = 0; i < 60; i++) {
      if (await page.getByTestId("session-summary").isVisible()) break;
      await flip(page);
      await page.getByTestId("rate-know").click();
      await page.waitForTimeout(20);
    }
    await expect(page.getByTestId("session-summary")).toBeVisible();

    const attempts = await idbCount(page, "study_attempts");
    const events = await idbCount(page, "review_events");
    const ratings = await idbRatings(page);
    // Exactly one wrong first attempt → exactly one Again event; the
    // reinforcement recovery is an extra attempt with NO extra event.
    expect(ratings.filter((rating) => rating === "again")).toHaveLength(1);
    expect(events).toBe(attempts - 1);
  });

  test("mobile: a real browser touch swipe grades the card", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "real touch gestures run on the mobile project");
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();

    // Tap to reveal, then a real right-swipe grades "I know".
    const client = await page.context().newCDPSession(page);
    await realTouchTap(client, page);
    await realTouchSwipe(client, page, "right");
    await client.detach();

    await expect(page.getByText(/Card 2 of/)).toBeVisible();
    await expect.poll(() => idbRatings(page)).toEqual(["good"]);
  });

  test("mobile: completes a session driven entirely by real touch gestures", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "touch swipe session runs on the mobile project");
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();

    // Touch-only: reveal by TAPPING the card and grade with a real browser
    // swipe (CDP touch protocol) — no keyboard, no programmatic focus, no
    // synthetic event dispatch.
    const client = await page.context().newCDPSession(page);
    for (let i = 0; i < 60; i++) {
      const card = page.getByTestId("flashcard");
      if (!(await card.isVisible())) break; // summary reached
      // Only act on a fresh (unflipped) card — the previous grade may still be
      // settling, and tapping a flipped card would just hide the answer again.
      if ((await card.getAttribute("data-flipped")) !== "false") {
        await page.waitForTimeout(40);
        continue;
      }
      await realTouchTap(client, page);
      await realTouchSwipe(client, page, "right"); // right = "I know"
      await page.waitForTimeout(60);
    }
    await client.detach();
    await expect(page.getByTestId("session-summary")).toBeVisible();
    expect(await idbCount(page, "review_events")).toBeGreaterThan(0);
  });

  test("undo is available from the summary and reverses the final card", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();

    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("session-summary").isVisible()) break;
      await flip(page);
      await page.getByTestId("rate-know").click();
      await page.waitForTimeout(20);
    }
    await expect(page.getByTestId("session-summary")).toBeVisible();
    const eventsBefore = await idbCount(page, "review_events");

    // The summary exposes Undo for the just-graded final card.
    await page.getByTestId("session-summary").getByTestId("undo").click();
    await expect(page.getByTestId("flashcard")).toBeVisible();
    await expect
      .poll(() => idbCount(page, "review_events"))
      .toBe(eventsBefore - 1);
  });

  test("reduced-motion uses the non-animated variant with no card transition", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/study/flashcards");
    const card = page.getByTestId("flashcard");
    await expect(card).toHaveAttribute("data-reduced-motion", "true");

    // The reduced variant renders a single face — no 3D transform element and
    // no non-trivial transition on the card.
    await flip(page);
    const transitionSeconds = await card.evaluate((el) =>
      parseFloat(getComputedStyle(el).transitionDuration),
    );
    expect(transitionSeconds).toBeLessThanOrEqual(0.001);
    const hasTransform = await card.evaluate(
      (el) => el.querySelector('[style*="rotateY"]') !== null,
    );
    expect(hasTransform).toBe(false);
  });

  test("rendered prompt and answer fields are always eligible", async ({
    page,
  }) => {
    await page.goto("/study/flashcards");
    const session = page.getByTestId("flashcard-session");
    await expect(session).toBeVisible();

    const release = loadLearnerRelease();

    // Inspect several successive cards' rendered fields against the release.
    for (let i = 0; i < 6; i++) {
      const entryId = Number(await session.getAttribute("data-entry-id"));
      const promptField = await session.getAttribute("data-prompt-field");
      const answerField = await session.getAttribute("data-answer-field");
      const entry = release.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error(`entry ${entryId} not in release`);
      // Flashcards are translation components: one side is a source form, the
      // other is the meaning — both must be quiz-eligible for this entry.
      for (const field of [promptField!, answerField!]) {
        expect(
          entry.quiz_eligibility[field as keyof typeof entry.quiz_eligibility],
          `entry ${entryId} field ${field} eligible`,
        ).toBe(true);
      }
      expect([promptField, answerField]).toContain("meaning");

      await flip(page);
      await page.getByTestId("rate-know").click();
      // Wait for the next card to mount (fresh cards start unflipped).
      await expect(page.getByTestId("flashcard")).toHaveAttribute(
        "data-flipped",
        "false",
      );
    }
  });

  test("the flashcards route has no accessibility violations (any impact)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/study/flashcards");
    await expect(page.getByTestId("flashcard")).toBeVisible();
    // A10 requires the route to PASS an axe scan — assert the full violations
    // array is empty (every impact level), not just serious/critical.
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
