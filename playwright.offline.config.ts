import { defineConfig, devices } from "@playwright/test";
import {
  E2E_OFFLINE_BASE_URL,
  offlineServerEnv,
} from "./e2e/helpers/e2e-server-env";

/**
 * The offline / PWA config (Phase 18, slice 12 — phases-18.md §8).
 *
 * The **only** config that builds and starts the app for real. Every other one
 * runs `next dev`, where `@serwist/turbopack` leaves the precache manifest as
 * an unreplaced placeholder and `components/pwa/service-worker-provider.tsx`
 * does not register — so there is no service worker to observe, and offline
 * behaviour cannot be tested from any of them. That is not a limitation to work
 * around; it is why this file exists.
 *
 * Two browser engines, because the two platforms this app targets install and
 * cache differently and only one of them can be reasoned about from the other.
 * WebKit is the engine of every iOS browser, so it is the only way to see what
 * an iPhone would do without an iPhone.
 *
 * `fullyParallel` is OFF. These specs share one server, one built app and — the
 * real reason — one service-worker registration story per browser context. A
 * spec that goes offline while a sibling is mid-navigation on the same worker
 * is a flake nobody will diagnose twice.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /(offline|pwa-installability|shell-touch)\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-offline" }],
  ],
  use: {
    baseURL: E2E_OFFLINE_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "pixel-7",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "iphone-webkit",
      use: { ...devices["iPhone 14"] },
    },
  ],
  webServer: {
    // A real build, then a real start. The build is inside the command rather
    // than in `globalSetup` so that Playwright's own readiness wait covers it:
    // a build failure surfaces as a webServer failure with its output attached,
    // not as every spec timing out against a port nothing is listening on.
    command: "pnpm build && pnpm start",
    url: E2E_OFFLINE_BASE_URL,
    reuseExistingServer: !process.env.CI,
    // Generous: this is the one config that pays for a full production build
    // before the first test runs.
    timeout: 600_000,
    env: offlineServerEnv(),
  },
});
