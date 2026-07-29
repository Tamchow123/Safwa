import { describe, expect, it } from "vitest";

import { resolveServiceWorkerEnabled } from "@/modules/env/client";

/**
 * `NEXT_PUBLIC_SW_ENABLED` is a tri-state, and each of the three states exists
 * for a different reason. These assert the reasons, not the truth table.
 */
describe("whether this build registers a service worker", () => {
  it("is off in a production build only when explicitly told", () => {
    // The kill switch. It has to work in production, which is the one place a
    // worker is otherwise on by default — an off switch that only works where
    // the thing is already off is not a rollback.
    expect(resolveServiceWorkerEnabled("false", "production")).toBe(false);
  });

  it("is on in a non-production build when explicitly told", () => {
    // Slice 12's offline Playwright config is the reason this direction has to
    // exist: it is the one place a worker must run outside a real deploy.
    expect(resolveServiceWorkerEnabled("true", "test")).toBe(true);
    expect(resolveServiceWorkerEnabled("true", "development")).toBe(true);
  });

  it("defaults to on in production and off everywhere else", () => {
    // Off under `next dev` keeps the four Playwright configs that predate this
    // phase behaviourally untouched, and keeps a development worker — whose
    // precache manifest @serwist/turbopack leaves as an unreplaced placeholder
    // — from being mistaken for the one that ships.
    expect(resolveServiceWorkerEnabled(undefined, "production")).toBe(true);
    expect(resolveServiceWorkerEnabled(undefined, "development")).toBe(false);
    expect(resolveServiceWorkerEnabled(undefined, "test")).toBe(false);
    expect(resolveServiceWorkerEnabled(undefined, undefined)).toBe(false);
  });

  it("treats a value it does not recognise as unset, not as off", () => {
    // Deliberate. A typo silently disabling offline support in production is
    // the worse failure and an invisible one: the app keeps working online, so
    // nothing surfaces until someone loses their connection.
    expect(resolveServiceWorkerEnabled("0", "production")).toBe(true);
    expect(resolveServiceWorkerEnabled("no", "production")).toBe(true);
    expect(resolveServiceWorkerEnabled("FALSE", "production")).toBe(true);
    expect(resolveServiceWorkerEnabled("", "production")).toBe(true);
  });
});
