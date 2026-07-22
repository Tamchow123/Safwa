import { defineConfig, devices } from "@playwright/test";
import {
  E2E_RATE_LIMITED_BASE_URL,
  rateLimitedServerEnv,
} from "./e2e/helpers/e2e-server-env";

/**
 * Dedicated config for e2e/auth-rate-limit.spec.ts (phases-15.md §60.7) —
 * see playwright.config.ts's docblock for why this needs its own config (a
 * `next dev` instance booted with a deliberately tight rate limit, which
 * cannot run concurrently with the main config's server from the same
 * project directory). Single worker: deterministic request counting
 * against a tight window requires this spec never race another test's
 * requests against the same (IP-keyed) limit.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /auth-rate-limit\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      { open: "never", outputFolder: "playwright-report-auth-rate-limit" },
    ],
  ],
  use: {
    baseURL: E2E_RATE_LIMITED_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "auth-rate-limit", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: E2E_RATE_LIMITED_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: rateLimitedServerEnv(),
  },
});
