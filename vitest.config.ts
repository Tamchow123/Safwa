import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    globals: true,
    // The default 5s per-test / per-hook budget is tight for this suite under
    // full parallelism: the jsdom + fake-IndexedDB tests each pass in well under
    // two seconds in isolation, but a ~1.7k-test run contends heavily (the
    // "importing the module does not construct anything" dynamic-import checks
    // are the first to flake). A generous ceiling absorbs that contention
    // without masking a genuine hang — a real infinite loop still trips it.
    testTimeout: 20000,
    hookTimeout: 20000,
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/**/*.test.{ts,tsx}",
      "modules/**/*.test.{ts,tsx}",
      "shared/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
    ],
    // Integration tests require a live disposable Postgres (pnpm
    // test:integration, its own vitest.integration.config.ts) — ordinary
    // unit tests must never depend on a running database.
    exclude: ["e2e/**", "tests/integration/**", "node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
    },
  },
});
