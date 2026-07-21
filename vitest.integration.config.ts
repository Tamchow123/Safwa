import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * Integration tests (`pnpm test:integration`) — disposable-Postgres
 * suites, deliberately excluded from the default `pnpm test` run/config
 * (phases-15.md §66: ordinary unit tests must never depend on a running
 * database). Every test file shares ONE physical database via
 * tests/integration/setup.ts's per-file reset; `fileParallelism: false`
 * keeps files from resetting/truncating out from under each other.
 *
 * Deliberate tradeoff, not an oversight: db/reset-test-database.ts's
 * database-name pattern already admits `safwa_test_<worker>` for future
 * per-worker isolation, but nothing derives a worker-scoped DATABASE_URL
 * today — every file runs fully serially against one database instead.
 * Revisit (wire a worker-derived DB name + drop `fileParallelism: false`)
 * once the integration suite's file count or wall-clock time makes serial
 * execution a real CI bottleneck — not before, since that machinery is
 * pure overhead for a suite this small.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/integration/setup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
