import { defineConfig, devices } from "@playwright/test";
import {
  E2E_AUTH_DISABLED_BASE_URL,
  authDisabledServerEnv,
} from "./e2e/helpers/e2e-server-env";

/**
 * Dedicated config for e2e/auth-disabled.spec.ts (phases-15.md §60.2) —
 * see playwright.config.ts's docblock for why this needs its own config
 * (a `next dev` instance booted with AUTH_ENABLED=false, which cannot run
 * concurrently with the main config's server from the same project
 * directory). `pnpm test:e2e` runs this AFTER the main config's run
 * completes (its webServer has already been torn down by then).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /auth-disabled\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    [
      "html",
      { open: "never", outputFolder: "playwright-report-auth-disabled" },
    ],
  ],
  use: {
    baseURL: E2E_AUTH_DISABLED_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "auth-disabled", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: E2E_AUTH_DISABLED_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: authDisabledServerEnv(),
  },
});
