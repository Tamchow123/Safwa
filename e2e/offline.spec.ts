import type { Page } from "@playwright/test";

import { CACHE_NAMES, OFFLINE_FALLBACK_URL } from "@/modules/pwa/cache-rules";

import { expect, test } from "./fixtures";
import {
  declineMergePrompt,
  freshEmail,
  login,
  registerAndVerify,
} from "./helpers/auth-flows";
import { reviewEventCountForUser, userIdByEmail } from "./helpers/db-probe";
import { e2eAccountOwnerKey, idbAll } from "./helpers/idb";
import { answerCorrectly } from "./helpers/quiz";
import {
  cachedUrls,
  waitForRuntimeCaches,
  waitForServiceWorkerControl,
} from "./helpers/service-worker";

/**
 * Offline study, end to end (Phase 18, slice 12 — phases-18.md §8).
 *
 * This is the phase's proof, and one assertion in it is the reason the phase
 * exists at all: **an offline cold boot must write rows owned by the ACCOUNT.**
 *
 * The defect §2 describes is client-side and silent. On a cold boot with no
 * network, Better Auth's session fetch rejects rather than staying in flight,
 * so `isPending` goes false with no data — and code that read that as "resolved
 * guest" would stamp every row the learner produced with `ownerKey: "guest"`.
 * Those rows are never uploaded, because the sync client only selects
 * account-owned ones. The learner sees a normal session and loses the lot. A
 * server-side probe cannot see this at all: the rows never reach the server. So
 * the assertion is made client-side, through `idbAll`, against the real account
 * id read from Postgres.
 *
 * **One test, several steps, deliberately.** Playwright gives every `test()` a
 * fresh browser context — new storage, new IndexedDB, and no service-worker
 * registration. A journey split across tests would therefore start each leg on
 * a device that had never seen this app, which is not a journey at all: the
 * first attempt at this spec was written that way and failed with
 * `ERR_INTERNET_DISCONNECTED` because the "offline" page had no worker to serve
 * it. `test.step` gives the reporting that splitting would have bought, without
 * throwing away the state the sequence is about.
 */
const STUDY_URL = "/study/mc";

/**
 * The one project that can emulate an offline navigation at all.
 *
 * **Measured, not assumed** (Playwright 1.61.1, this config, both projects): in
 * WebKit *every* navigation attempted while `context.setOffline(true)` is in
 * effect rejects with `WebKit encountered an internal error` — `page.goto`,
 * `page.reload`, and a `newPage()` cold boot alike. It is not caused by the
 * service worker and it is not something this app does: the same internal error
 * appears in a context created with `serviceWorkers: "block"` that goes offline
 * before its very first navigation, where no worker exists and nothing has been
 * cached. Chromium in the same run returns a clean
 * `net::ERR_INTERNET_DISCONNECTED` for that case and completes every offline
 * navigation once a worker is in control.
 *
 * So this is a limitation of the harness, not a gap in the app or in what is
 * being tested — but it is a real limit on what an automated run can claim, and
 * it must not be papered over. Two things follow, and both are deliberate:
 *
 * 1. Everything that depends on an offline **navigation** runs on Chromium only,
 *    pinned by name here rather than left to accident.
 * 2. What WebKit *can* observe is asserted on WebKit instead of skipped —
 *    "the worker installs, controls, and stores what an offline session needs"
 *    below, plus the whole of `pwa-installability.spec.ts` and
 *    `shell-touch.spec.ts`. In-page `fetch()` offline emulation does work on
 *    WebKit, so only the navigation step is out of reach.
 *
 * The residue — an actual offline navigation on a real iOS Safari — is a human
 * check, H4 in phases-18.md §12, which is a real install on a real iPhone and
 * therefore stronger than anything WebKit could have shown. §11 records this so
 * it is not mistaken for something automation covers.
 */
const OFFLINE_CAPABLE_PROJECT = "pixel-7";

test.describe("offline study", () => {
  // The journey disconnects the network on purpose, so resource-load failures
  // are expected. Hydration and runtime errors are still caught by the guard in
  // `fixtures.ts` — which is the whole reason this spec uses that `test` rather
  // than Playwright's own.
  test.use({ allowExpectedNetworkErrors: true });

  // One long journey on a real production build, including a registration and
  // email-verification round trip.
  test.slow();

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== OFFLINE_CAPABLE_PROJECT,
      "WebKit cannot emulate an offline navigation — see OFFLINE_CAPABLE_PROJECT",
    );
  });

  test("study online, go offline, keep studying, reconnect", async ({
    context,
    page,
  }) => {
    const email = freshEmail("offline");
    let accountId = "";

    await test.step("register, verify and sign in", async () => {
      await registerAndVerify(page, email);
      await login(page, email);
      await declineMergePrompt(page);

      const id = await userIdByEmail(email);
      expect(id, "the account should exist in Postgres").not.toBeNull();
      accountId = id!;
    });

    await test.step("study online until a worker is in control", async () => {
      await page.goto(STUDY_URL);
      // An explicit timeout on the FIRST render, not the default 5s. This is a
      // real production build on an emulated phone, and the first quiz has to
      // read the content release out of IndexedDB before it can show anything —
      // comfortably under 5s in Chromium and not in WebKit, which is the only
      // reason this number is here.
      await expect(page.getByTestId("mc-quiz-session")).toBeVisible({
        timeout: 30_000,
      });
      await answerCorrectly(page);
      await expect(page.getByTestId("mc-next")).toBeVisible();

      await waitForServiceWorkerControl(page);

      // Navigate AGAIN, now that a worker exists. The navigations above
      // happened before it did, so the worker never saw them and nothing about
      // them was cached — a first visit installs the worker, a second visit is
      // the one it can answer for. Not test scaffolding: it is what actually
      // happens to a learner, and skipping it would make the offline steps
      // below fail for a reason that has nothing to do with being offline.
      await page.goto(STUDY_URL);
      await expect(page.getByTestId("mc-quiz-session")).toBeVisible({
        timeout: 30_000,
      });
      await waitForRuntimeCaches(page);

      // Assert WHAT was cached, not merely that something was. Otherwise an
      // offline failure below cannot be told apart from "the online half never
      // stored anything", which is the failure mode that wastes the most time.
      await expect
        .poll(() => cachedUrls(page, CACHE_NAMES.documents), {
          timeout: 15_000,
        })
        .toEqual(expect.arrayContaining([expect.stringContaining(STUDY_URL)]));

      // Warmed during the worker's `install`, and the only thing that can
      // answer a navigation to a route the learner has never opened.
      expect(await cachedUrls(page, CACHE_NAMES.offlineFallback)).toEqual([
        expect.stringContaining(OFFLINE_FALLBACK_URL),
      ]);
    });

    await test.step("cold-boot offline and study as the account", async () => {
      await context.setOffline(true);

      // A NEW page, not a reload: a reload can be served from memory and from
      // an already-resolved React tree, which proves much less than a document
      // request that has to come out of Cache Storage. The page rendering at
      // all is also §10's "the worker has a fetch handler" criterion, proved
      // the only way that is honest on both engines — with the network off,
      // nothing else can have answered.
      const cold = await context.newPage();
      await cold.goto(STUDY_URL);
      await expect(cold.getByTestId("mc-quiz-session")).toBeVisible({
        timeout: 30_000,
      });

      // §2's regression test. The learner is signed in and offline; nothing may
      // offer to merge their own account's work into their own account.
      await expect(cold.getByTestId("guest-merge-dialog")).toHaveCount(0);

      // TWO questions, not one. The owner is resolved per write, so a single
      // event proves only that the first write was attributed correctly — and
      // the failure mode §2 describes is a resolution that settles late, which
      // is precisely the shape that can get the first write right and later ones
      // wrong (or the reverse). Answering twice with a "Next" in between is also
      // the first point at which the offline session advances state rather than
      // merely rendering.
      await answerCorrectly(cold);
      await expect(cold.getByTestId("mc-next")).toBeVisible();
      await cold.getByTestId("mc-next").click();
      await answerCorrectly(cold);
      await expect(cold.getByTestId("mc-next")).toBeVisible();

      const events = (await idbAll(cold, "review_events")) as {
        ownerKey?: string;
      }[];
      expect(
        events.length,
        "two offline answers should have produced two events",
      ).toBeGreaterThanOrEqual(2);
      // THE assertion. Not "some rows are account-owned" — none may be guest's.
      expect([...new Set(events.map((event) => event.ownerKey))]).toEqual([
        e2eAccountOwnerKey(accountId),
      ]);

      // Still offline: the queue is durable, not in memory.
      await cold.reload();
      await expect(cold.getByTestId("mc-quiz-session")).toBeVisible({
        timeout: 30_000,
      });
      expect(
        ((await idbAll(cold, "review_events")) as unknown[]).length,
      ).toBeGreaterThanOrEqual(events.length);

      await cold.close();
    });

    await test.step("a route never opened online falls back", async () => {
      // Deliberately a real route this journey never visited, so the document
      // cache cannot hold it and `handlerDidError` is the only thing that can
      // answer.
      const unseen = await context.newPage();
      await unseen.goto("/library/saved");
      await expect(
        unseen.getByRole("heading", { name: /offline/i }),
      ).toBeVisible({ timeout: 30_000 });
      await unseen.close();
    });

    await test.step("reconnect, and the offline work reaches the server", async () => {
      await context.setOffline(false);
      await page.goto(STUDY_URL);
      await expect(page.getByTestId("mc-quiz-session")).toBeVisible({
        timeout: 30_000,
      });
      // The SERVER's own count. The client's was already asserted while
      // offline; re-reading it here would only restate it, and what this step
      // is about is that the queue drained.
      await expect
        .poll(() => reviewEventCountForUser(accountId), { timeout: 30_000 })
        .toBeGreaterThan(0);
    });
  });
});

/**
 * What the worker stores — asserted on **both** engines.
 *
 * This is the WebKit half of the coverage the pinned journey above cannot give,
 * and it is not a consolation prize: everything an offline session reads has to
 * be in Cache Storage before the network goes away, so "the worker installs,
 * controls, and stores the right things" is most of the mechanism. Only the
 * final step — serving a navigation from those caches with the network off — is
 * unobservable on WebKit, and the Cache Storage API that proves the rest works
 * there identically.
 *
 * A guest, deliberately: no registration, no email round trip, so this runs in
 * seconds on the slower engine and cannot fail for an auth reason. Which cache
 * a URL lands in is `modules/pwa/cache-rules.ts`'s decision, so the names come
 * from `CACHE_NAMES` rather than being spelled out again here — a rename that
 * broke this would break the worker too, and should not be able to pass.
 */
test.describe("the worker stores what an offline session needs", () => {
  // Not because this test goes offline — it never does. WebKit reports an RSC
  // prefetch that was still in flight when the page navigated away as a console
  // error, and a controlled page produces several per journey; `fixtures.ts`
  // documents the wording and the trade-off. Chromium logs nothing for the same
  // event, so without this the guard would fail on one engine only.
  test.use({ allowExpectedNetworkErrors: true });

  test("install precaches the fallback, and browsing fills the runtime caches", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForServiceWorkerControl(page);

    // As in the journey: the first visit installs the worker, the second is the
    // one it can answer for.
    await page.goto("/");
    await waitForRuntimeCaches(page);

    // Warmed during `install`, not by browsing — this is what answers a
    // navigation to a route the learner never opened.
    expect(
      await cachedUrls(page, CACHE_NAMES.offlineFallback),
      "the offline fallback is precached at install",
    ).toEqual([expect.stringContaining(OFFLINE_FALLBACK_URL)]);

    await expect
      .poll(() => cachedUrls(page, CACHE_NAMES.documents), { timeout: 15_000 })
      .not.toEqual([]);

    await expect
      .poll(() => cachedUrls(page, CACHE_NAMES.buildAssets), {
        timeout: 15_000,
      })
      .not.toEqual([]);

    // The release POINTER, which is re-fetched on every load and so is the
    // content rule a controlled page actually exercises.
    //
    // Its sibling rule — `CacheFirst` for each release's `learner.json` — is
    // deliberately NOT asserted here, and the reason is worth writing down
    // because the obvious test for it passes for the wrong reason or not at all.
    // `modules/content/load.ts` verifies and stores the release in Dexie on the
    // FIRST load, which happens before any worker controls the page; every load
    // after that reads Dexie and never requests `learner.json` again. So a
    // controlled page has nothing to cache, `safwa-content-releases` stays
    // empty, and an assertion that it is populated fails — measured, three
    // times, before this comment replaced it.
    //
    // That is not a defect: it is §7.1's point restated from the other side.
    // The release rule is redundancy for the case where the Dexie copy is
    // missing or fails verification, not the mechanism by which content loads
    // offline. `modules/pwa/cache-rules.test.ts` owns proving the rule matches
    // the right URLs; `pnpm sw:verify` owns proving it reached the worker
    // bundle. Neither needs a browser, and both are the honest place for it.
    await page.goto("/library");
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 30_000 },
    );
    await expect
      .poll(() => cachedUrls(page, CACHE_NAMES.contentPointer), {
        timeout: 15_000,
      })
      .toEqual(
        expect.arrayContaining([expect.stringContaining("active.json")]),
      );
  });
});

/**
 * A corrupt release is still rejected with a worker in the way (§8's "plus"
 * list).
 *
 * `content-foundation.spec.ts` already proves the checksum path, but it proves
 * it on a `next dev` server where **no service worker exists**. This phase
 * inserts a `CacheFirst` rule for each release's `learner.json` and a
 * `NetworkFirst` rule for the pointer between `modules/content/load.ts` and the
 * network, and a cache that can replay a response is exactly the sort of thing
 * that can smuggle unverified bytes past a check that ran once. So the same
 * guarantee is re-proved here, in the one configuration where a worker is
 * actually in control.
 *
 * **`context.route`, not `page.route` — measured.** With a worker controlling
 * the page, `page.route` stopped firing entirely (0 hits) while `context.route`
 * received the worker's own fetches (2 hits); before the worker took control the
 * counts were exactly reversed. A `page.route` copy of this test would pass
 * while intercepting nothing, which is worse than not having it. Playwright's
 * worker-request interception is Chromium-only, so this is pinned to the same
 * project as the journey.
 */
test.describe("a corrupt release cannot get past the worker", () => {
  const CORRUPT_RELEASE_ID = "safwa-2.2.0-corrupt000000000";

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== OFFLINE_CAPABLE_PROJECT,
      "Playwright intercepts service-worker requests in Chromium only",
    );
  });

  async function waitForLibrary(page: Page): Promise<void> {
    await expect(page.getByTestId("library-result-count")).toHaveText(
      /entries/,
      { timeout: 30_000 },
    );
  }

  test("checksum mismatch falls back to the previous verified release", async ({
    context,
    page,
  }) => {
    await page.goto("/library");
    await waitForLibrary(page);
    await waitForServiceWorkerControl(page);

    // Second visit, so the content fetches below are the worker's.
    await page.goto("/library");
    await waitForLibrary(page);
    const validReleaseId = await page
      .getByTestId("content-release-id")
      .textContent();
    expect(validReleaseId).toMatch(/^safwa-/);

    // Point at a "new" release whose bytes will not match its checksum.
    await context.route("**/content/active.json", async (route) => {
      const response = await route.fetch();
      const pointer = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        json: {
          ...pointer,
          release_id: CORRUPT_RELEASE_ID,
          learner_url: `/content/releases/${CORRUPT_RELEASE_ID}/learner.json`,
        },
      });
    });
    await context.route(
      `**/content/releases/${CORRUPT_RELEASE_ID}/**`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: `{"release_id":"${CORRUPT_RELEASE_ID}","tampered":true}`,
        });
      },
    );

    await page.getByRole("button", { name: "Refresh content" }).click();
    await waitForLibrary(page);

    // The corrupt release is rejected and the previously verified one still
    // serves. Not an offline case, so the label must not claim offline.
    await expect(page.getByTestId("content-source")).toHaveText(
      "using the previous verified cached release",
    );
    await expect(page.getByTestId("content-release-id")).toHaveText(
      validReleaseId ?? "",
    );
    await expect(page.getByTestId("library-result-count")).toHaveText(
      "455 entries",
    );

    // And it survives a reload: had the corrupt release been accepted and
    // written to Dexie, this is where it would surface.
    await page.reload();
    await waitForLibrary(page);
    await expect(page.getByTestId("content-release-id")).toHaveText(
      validReleaseId ?? "",
    );
  });
});

/**
 * The `Cache-Control` contract `modules/pwa/cache-policy.ts` depends on
 * (T10 round 2, SEC-002).
 *
 * `isPrivateResponse` decides what may be written to the document and RSC
 * caches by reading this header, and until now nothing asserted the header
 * actually says what it was measured to say. `page.request` is deliberate: it
 * is a Node-side fetch that does not go through the service worker, so what is
 * asserted here is the SERVER's response rather than something replayed from a
 * cache.
 *
 * `docs/DEPLOYMENT.md` §5d carries the other half — the same check against the
 * real host, because a CDN edge is what can normalise a header away and no
 * server started by this config will ever be one.
 */
test.describe("the Cache-Control contract the cache policy rests on", () => {
  // One project, not both. What is asserted here is a SERVER response header,
  // which is identical whatever engine asked for it — so a second run buys no
  // coverage, and buys it at the price of a second registration and
  // email-verification round trip on the slower engine. Pinned to the project
  // by name rather than left to run twice, so the choice is visible.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== OFFLINE_CAPABLE_PROJECT,
      "server headers are engine-independent; asserted once",
    );
  });

  test("a dynamically rendered route refuses to be cached", async ({
    page,
  }) => {
    const email = freshEmail("cachecontrol");
    await registerAndVerify(page, email);
    await login(page, email);
    await declineMergePrompt(page);

    // /account server-renders the learner's name and email. If this ever comes
    // back cacheable, the service worker is storing account markup.
    const response = await page.request.get("/account");
    expect(response.status()).toBe(200);
    const header = (response.headers()["cache-control"] ?? "").toLowerCase();
    expect(header, "/account Cache-Control").toMatch(/no-store|private/);
  });

  test("a prerendered route stays cacheable", async ({ page }) => {
    // The other half. Refusing this would cost offline study the app shell to
    // protect nothing, so the contract has to fail in both directions.
    const response = await page.request.get("/study");
    expect(response.status()).toBe(200);
    const header = (response.headers()["cache-control"] ?? "").toLowerCase();
    expect(header, "/study Cache-Control").not.toMatch(/no-store|private/);
  });
});
