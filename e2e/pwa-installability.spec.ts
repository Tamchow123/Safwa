import { expect, test } from "./fixtures";
import {
  serviceWorkerRegistrationCount,
  waitForServiceWorkerControl,
} from "./helpers/service-worker";

/**
 * Installability (Phase 18, slice 12 — phases-18.md §10).
 *
 * The phase checkpoint in `IMPLEMENTATION_PHASES.md` asks for a "Lighthouse PWA
 * installability pass". **Lighthouse removed the PWA category in v12**, so that
 * is not automatable by any current version. Rather than skip it or pretend a
 * different Lighthouse audit is the same thing, §10 substitutes the explicit
 * criteria Lighthouse used to assert, checked here directly.
 *
 * These run on both engines. The manifest and icons are served identically, but
 * whether WebKit registers a worker at all is exactly the sort of thing that
 * cannot be assumed from Chromium — so the worker criterion is asserted per
 * project rather than once.
 */
test.describe("§10 installability criteria", () => {
  test("the manifest is served, parses, and declares what an install needs", async ({
    page,
  }) => {
    const response = await page.request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);

    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBeTruthy();
  });

  test("it declares a 192px and a 512px icon, and every icon URL resolves", async ({
    page,
  }) => {
    const manifest = (await (
      await page.request.get("/manifest.webmanifest")
    ).json()) as { icons?: { src: string; sizes?: string }[] };

    const icons = manifest.icons ?? [];
    expect(icons.length).toBeGreaterThan(0);

    /** The largest square edge a `sizes` string declares, or 0. */
    const largestEdge = (sizes: string | undefined): number =>
      Math.max(
        0,
        ...(sizes ?? "")
          .split(/\s+/)
          .map((size) => Number.parseInt(size.split("x")[0] ?? "", 10))
          .filter((edge) => Number.isFinite(edge)),
      );

    const edges = icons.map((icon) => largestEdge(icon.sizes));
    expect(Math.max(...edges)).toBeGreaterThanOrEqual(512);
    expect(edges.some((edge) => edge >= 192)).toBe(true);

    // Every declared URL, not a sample. A manifest that names an icon the
    // server does not have is installable-looking and produces a broken home
    // screen — and `sw:verify` cannot see this, because the manifest is data
    // rather than code.
    for (const icon of icons) {
      const iconResponse = await page.request.get(icon.src);
      expect(iconResponse.status(), `icon ${icon.src}`).toBe(200);
    }
  });

  test("a service worker registers and controls the page", async ({ page }) => {
    await page.goto("/");
    await waitForServiceWorkerControl(page);
    expect(await serviceWorkerRegistrationCount(page)).toBeGreaterThan(0);
  });

  test("the page is a secure context", async ({ page }) => {
    // `http://localhost` counts, which is why the worker registers here at all.
    // In production this is TLS; the criterion is the same one either way, and
    // asserting it here means a config change that moved these specs to a
    // non-localhost host over plain HTTP would fail loudly rather than silently
    // stop testing service workers.
    await page.goto("/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  });
});

/**
 * §10's remaining criterion is "a service worker … has a `fetch` handler".
 *
 * There is no honest way to introspect that: the DevTools protocol can, but
 * only in Chromium, and a WebKit run would then be asserting something weaker
 * while looking identical. `offline.spec.ts` proves it the way that actually
 * matters — the page loads with the network switched off, which is only
 * possible if a `fetch` handler answered. That assertion lives there rather
 * than being duplicated here, and this comment exists so the criterion is not
 * mistaken for one nothing checks.
 */
