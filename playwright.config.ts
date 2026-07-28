import { defineConfig, devices } from "@playwright/test";
import { E2E_MAIN_BASE_URL, mainServerEnv } from "./e2e/helpers/e2e-server-env";

// e2e/auth-disabled.spec.ts (§60.2) and e2e/auth-rate-limit.spec.ts (§60.7)
// each need a `next dev` instance booted with a DIFFERENT AUTH_ENABLED /
// rate-limit configuration than every other spec (both are read once and
// memoised per server process — modules/env/server.ts). `next dev` also
// refuses to run a second concurrent instance from the same project
// directory at all, regardless of port ("Another next dev server is
// already running") — so a single Playwright config cannot run three
// simultaneous webServers here. Each of those two specs instead has its
// own SEPARATE Playwright config (playwright.auth-disabled.config.ts,
// playwright.auth-rate-limit.config.ts) with its own single webServer;
// `pnpm test:e2e` runs all three configs one after another (never
// overlapping), and this config explicitly ignores both files so they are
// never accidentally picked up here too.
const SPECIAL_SERVER_SPECS = [
  /e2e\/auth-disabled\.spec\.ts/,
  /e2e\/auth-rate-limit\.spec\.ts/,
  // Runs against its own SYNC_ENABLED=false server (playwright.sync-disabled.config.ts).
  /e2e\/sync-disabled\.spec\.ts/,
];

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  /*
   * 60s, not Playwright's default 30s (Phase 17).
   *
   * These specs run in parallel against ONE `next dev` server, which compiles
   * routes on demand. A test that navigates to a route no worker has visited
   * yet pays for that compile, and several workers doing it at once is enough
   * to push a perfectly healthy journey past 30 seconds — which showed up as
   * a DIFFERENT test failing on each run while every one of them passed in
   * isolation. Phase 17's merge journeys (register, verify by email, study,
   * merge) are long enough to make it routine rather than occasional.
   *
   * This is a budget, not a tolerance: nothing here waits 60s in the ordinary
   * case, and no assertion was relaxed to fit.
   */
  timeout: 60_000,
  expect: {
    // Likewise: the same contention delays a single assertion's element.
    timeout: 10_000,
  },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E_MAIN_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: SPECIAL_SERVER_SPECS,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testIgnore: SPECIAL_SERVER_SPECS,
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: E2E_MAIN_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: mainServerEnv(),
  },
});
