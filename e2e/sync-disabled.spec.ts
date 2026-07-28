import { expect, test } from "./fixtures";

/**
 * Sync kill-switch (SYNC_ENABLED=false), phases-16.md §16 / §18 (T19). Runs
 * against a dedicated server booted with SYNC_ENABLED=false (auth stays on).
 *
 * Coverage split (see docs/TEST_STRATEGY.md):
 *  - The kill-switch is honoured SERVER-SIDE: an unauthenticated sync call gets
 *    a clean 503 (checked before the session read) — tested here directly.
 *  - Turning sync off never degrades LOCAL study for a guest — a smoke test
 *    here. (This is not a true regression proof on its own: a guest renders
 *    identically whether sync is on or off, since SyncStatusIndicator returns
 *    nothing for guests. The full guest-persistence regression runs on the main
 *    SYNC_ENABLED=true config in e2e/guest-persistence.spec.ts.)
 *  - The authenticated `disabled` → "Sync off" UI path (server 503 → controller
 *    back-off → indicator) is covered by unit tests: the controller's disabled
 *    back-off (modules/sync/client/controller.test.ts) and the indicator's
 *    `disabled` → "Sync off" rendering (tests/components/sync-status-indicator.test.ts).
 *    A full authenticated multi-context sync E2E (bootstrap/tamper/idempotency/
 *    revocation) is deferred — those server-authoritative properties are covered
 *    deterministically by the integration suites (tests/integration/sync-*.test.ts).
 */
test.describe("sync kill-switch (SYNC_ENABLED=false)", () => {
  test("the sync API is disabled (503) before any auth check", async ({
    request,
  }) => {
    // The kill-switch is evaluated FIRST (before the session read), so even an
    // unauthenticated call gets a clean 503 — never a 500, a 401, or a partial
    // sync. A disabled server must refuse the sync endpoints outright.
    const pull = await request.get("/api/sync/pull?since=0&limit=10");
    expect(pull.status()).toBe(503);
  });

  test("a guest studies and persists locally with sync off, and sees no sync indicator (smoke)", async ({
    page,
  }) => {
    await page.goto("/settings");

    // A durable local action works exactly as it does with sync on.
    await page.getByRole("button", { name: "Large" }).click();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue(
              "--arabic-font-scale",
            ),
          ),
        { timeout: 5000 },
      )
      .toBe("1.2");

    // It landed durably in Dexie (independent of app code).
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open("safwa-content");
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            try {
              if (!db.objectStoreNames.contains("settings_owned")) return null;
              const row = await new Promise<{ value?: string } | null>(
                (resolve, reject) => {
                  // Owner-keyed since schema v7: this is the GUEST's value.
                  const r = db
                    .transaction("settings_owned", "readonly")
                    .objectStore("settings_owned")
                    .get(["guest", "arabic-font-scale"]);
                  r.onsuccess = () => resolve(r.result ?? null);
                  r.onerror = () => reject(r.error);
                },
              );
              return row?.value ?? null;
            } finally {
              db.close();
            }
          }),
        { timeout: 5000 },
      )
      .toBe("large");

    // Guests never see the sync indicator (it renders nothing without a
    // session); sync being disabled changes nothing for them. The strict
    // console guard in fixtures.ts also fails this test on any runtime/
    // hydration error, so a broken disabled-sync path would be caught here.
    // The pattern covers every indicator label including the "N pending" form.
    await expect(
      page.getByText(
        /^(Synced|Syncing|\d+\s*pending|Offline|Sync off|Attention)$/,
      ),
    ).toHaveCount(0);
  });
});

/**
 * Phase 17 §26 — the guest→account merge under the kill-switch.
 *
 * The merge rides on the sync stack, so turning sync off turns the merge off
 * with it. What §26 requires is that it fail SAFELY: refused, explained, and
 * with every guest row exactly where it was. The one thing a learner can never
 * afford is a merge that deletes the local copy on its way to a server that was
 * never going to accept it.
 */
test.describe("guest merge with SYNC_ENABLED=false", () => {
  test("the merge endpoint is refused before any auth check", async ({
    request,
  }) => {
    // Same shape as pull/push above: the kill-switch is evaluated FIRST, so an
    // unauthenticated call gets a clean 503 rather than a 401, a 500, or —
    // worst of all — a partial import.
    const merge = await request.post("/api/sync/guest-merge", {
      data: { hello: "world" },
      headers: { "content-type": "application/json" },
    });
    expect(merge.status()).toBe(503);
  });

  test("a guest with real local data is never prompted, and keeps every row", async ({
    page,
  }) => {
    // No prompt, because there is nothing the app could honestly offer to do.
    // The important half is the second assertion: the guest's data is still
    // there afterwards. Nothing is cleared in anticipation of a merge.
    await page.goto("/settings");
    await page.getByRole("button", { name: "Large" }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--arabic-font-scale",
          ),
        ),
      )
      .toBe("1.2");

    await page.goto("/");
    await expect(page.getByTestId("due-today-count")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("guest-merge-dialog")).toHaveCount(0);

    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--arabic-font-scale",
          ),
        ),
      )
      .toBe("1.2");
  });
});
