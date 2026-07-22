/**
 * Playwright global setup for the Phase 15 auth E2E suite (phases-15.md
 * §60). Runs once before any `webServer` traffic is exercised: resets the
 * disposable `safwa_test` Postgres database to a clean, migrated, seeded
 * state, and clears the file-based email outbox — so every spec starts
 * from the same known-empty state, exactly as `tests/integration/setup.ts`
 * does per-file for the Vitest integration suite.
 *
 * Shells out to the existing `pnpm db:test:reset` / `pnpm
 * email:clear-outbox` CLI scripts rather than importing
 * `db/reset-test-database.ts`/`modules/email/clear-outbox.ts` directly —
 * both modules (transitively) carry a `server-only` marker that only
 * resolves under Vitest's mock or `tsx --conditions=react-server`, neither
 * of which Playwright's Node process provides.
 */
import { execFileSync } from "node:child_process";
import {
  E2E_DATABASE_URL,
  E2E_EMAIL_OUTBOX_DIR,
} from "./helpers/e2e-server-env";

// A hung reset (unreachable Postgres, a stuck migration lock) must fail
// fast with a diagnosable error rather than blocking the whole run with
// no signal until an external CI job timeout eventually intervenes.
const SUBPROCESS_TIMEOUT_MS = 60_000;

export default function globalSetup(): void {
  // shell:true — Windows' pnpm shim is a .cmd file, which execFileSync
  // cannot invoke directly without shell interpretation (EINVAL
  // otherwise); shelling out is safe here since both arguments are fixed
  // literals, never interpolated from external input.
  execFileSync("pnpm", ["db:test:reset"], {
    stdio: "inherit",
    shell: true,
    timeout: SUBPROCESS_TIMEOUT_MS,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: E2E_DATABASE_URL,
    },
  });

  execFileSync("pnpm", ["email:clear-outbox"], {
    stdio: "inherit",
    shell: true,
    timeout: SUBPROCESS_TIMEOUT_MS,
    env: {
      ...process.env,
      EMAIL_OUTBOX_DIR: E2E_EMAIL_OUTBOX_DIR,
    },
  });
}
