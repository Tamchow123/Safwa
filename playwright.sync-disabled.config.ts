import { defineConfig, devices } from "@playwright/test";
import {
  E2E_SYNC_DISABLED_BASE_URL,
  syncDisabledServerEnv,
} from "./e2e/helpers/e2e-server-env";

/**
 * Dedicated config for e2e/sync-disabled.spec.ts (phases-16.md §16, T19) — a
 * `next dev` instance booted with SYNC_ENABLED=false (auth stays on) to exercise
 * the sync kill-switch. Like the auth-disabled config, it needs its own server
 * (a different SYNC_ENABLED value cannot be applied to the main config's already
 * running instance), so `pnpm test:e2e` runs it AFTER the main run's webServer
 * has been torn down.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /sync-disabled\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    [
      "html",
      { open: "never", outputFolder: "playwright-report-sync-disabled" },
    ],
  ],
  use: {
    baseURL: E2E_SYNC_DISABLED_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "sync-disabled", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: E2E_SYNC_DISABLED_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: syncDisabledServerEnv(),
  },
});
