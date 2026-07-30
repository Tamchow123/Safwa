import { defineConfig, devices } from "@playwright/test";
import {
  E2E_SIGNUP_CLOSED_BASE_URL,
  signupClosedServerEnv,
} from "./e2e/helpers/e2e-server-env";

/**
 * Dedicated config for e2e/signup-closed.spec.ts (phases-18.md §5 slice 6) —
 * see playwright.config.ts's docblock for why each server variant needs its own
 * config (one `next dev` instance per environment, and they cannot run
 * concurrently from the same project directory).
 *
 * This one boots with `SIGNUP_ALLOWED_EMAILS` set. Every other E2E server
 * leaves it unset so their specs can register throwaway accounts freely, which
 * is exactly why the allowlist needs a server of its own: without one, nothing
 * in the E2E layer would ever exercise a closed instance, and the production
 * configuration would be the first place it ran.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /signup-closed\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      { open: "never", outputFolder: "playwright-report-signup-closed" },
    ],
  ],
  use: {
    baseURL: E2E_SIGNUP_CLOSED_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "signup-closed", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: E2E_SIGNUP_CLOSED_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: signupClosedServerEnv(),
  },
});
