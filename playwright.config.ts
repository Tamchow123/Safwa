import { defineConfig, devices } from "@playwright/test";
import { E2E_MAIN_BASE_URL, mainServerEnv } from "./e2e/helpers/e2e-server-env";

// Several specs each need a `next dev` instance booted with a DIFFERENT
// environment than every other spec — auth-disabled (§60.2), auth-rate-limit
// (§60.7), sync-disabled (phases-16.md §16) and signup-closed (phases-18.md
// §5 slice 6). Every one of those variables is read once and memoised per
// server process (modules/env/server.ts), and `next dev` refuses to run a
// second concurrent instance from the same project directory at all,
// regardless of port ("Another next dev server is already running") — so a
// single Playwright config cannot run several simultaneous webServers here.
// Each of those specs instead has its own SEPARATE Playwright config with its
// own single webServer; `pnpm test:e2e` runs every config one after another
// (never overlapping), and this config explicitly ignores those files so they
// are never accidentally picked up here too.
const SPECIAL_SERVER_SPECS = [
  /e2e\/auth-disabled\.spec\.ts/,
  /e2e\/auth-rate-limit\.spec\.ts/,
  // Runs against its own SYNC_ENABLED=false server (playwright.sync-disabled.config.ts).
  /e2e\/sync-disabled\.spec\.ts/,
  // Runs against its own SIGNUP_ALLOWED_EMAILS server
  // (playwright.signup-closed.config.ts). It MUST be ignored here: this
  // server leaves sign-up open, so every one of that spec's refusals would
  // instead register an account and the spec would fail for the wrong reason.
  /e2e\/signup-closed\.spec\.ts/,
  // The Phase 18 offline/PWA suite (playwright.offline.config.ts). Ignored here
  // for a stronger reason than the four above: this server runs `next dev`,
  // where `@serwist/turbopack` leaves the precache manifest unreplaced and
  // `components/pwa/service-worker-provider.tsx` never registers — so there is
  // no service worker for these specs to observe and they fail on the absence
  // of the very thing they exist to test. That is not a flake to tune; it is the
  // wrong server. Their own config builds and starts the app for real.
  //
  // `shell-touch.spec.ts` is deliberately NOT in this list even though it is part
  // of that suite: it measures rendered box sizes and needs no worker, so it runs
  // here as well. That is the point — the offline job is not yet a required check
  // on `main` (phases-18.md §12, H6), so this config is what actually holds the
  // 44px rule to account until it is.
  /e2e\/offline\.spec\.ts/,
  /e2e\/pwa-installability\.spec\.ts/,
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
