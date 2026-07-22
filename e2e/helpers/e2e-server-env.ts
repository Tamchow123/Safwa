/**
 * Shared env computation for the Phase 15 auth E2E suite (phases-15.md
 * §60). Imported by BOTH `playwright.config.ts` (to build each
 * `webServer`'s `env`) and `e2e/global-setup.ts` (to reset the same
 * database/outbox before any server starts) — one source of truth so the
 * two can never disagree on which database or outbox directory is in use.
 *
 * Deliberately reuses the same disposable `safwa_test` database and
 * `.local/email-outbox` directory the Vitest integration suite uses
 * (db/reset-test-database.ts's own safety pattern), rather than
 * provisioning a second database — `pnpm test:e2e` and `pnpm
 * test:integration` are not intended to run concurrently against the same
 * local Postgres instance; CI (T21) runs them as separate steps.
 *
 * This file has NO `server-only` import anywhere in its chain — it must be
 * safely importable from `playwright.config.ts` and Playwright's own Node
 * test/config process, which has no equivalent of Vitest's `server-only`
 * mock and does not run under `--conditions=react-server`.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "e2e-server-env: DATABASE_URL must be set (via .env.local) to run the E2E suite.",
    );
  }
  const url = new URL(base);
  url.pathname = "/safwa_test";
  return url.toString();
}

export const E2E_DATABASE_URL = testDatabaseUrl();
export const E2E_EMAIL_OUTBOX_DIR = ".local/email-outbox";
export const E2E_BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ?? "e2e-test-secret-value-not-for-production";

export const E2E_PORTS = {
  /** Normal auth-enabled server, generous rate limit (most specs). */
  main: 3100,
  /** AUTH_ENABLED=false (phases-15.md §60.2). */
  authDisabled: 3101,
  /** Auth-enabled, deliberately tight rate limit (phases-15.md §60.7). */
  rateLimited: 3102,
} as const;

function baseUrlFor(port: number): string {
  return `http://localhost:${port}`;
}

export type E2EServerEnv = Record<string, string>;

/** Common env every E2E-launched `next dev` instance needs, regardless of server variant. */
function commonEnv(port: number): E2EServerEnv {
  const baseUrl = baseUrlFor(port);
  return {
    DATABASE_URL: E2E_DATABASE_URL,
    BETTER_AUTH_SECRET: E2E_BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: baseUrl,
    NEXT_PUBLIC_APP_URL: baseUrl,
    EMAIL_TRANSPORT: "console-file",
    EMAIL_OUTBOX_DIR: E2E_EMAIL_OUTBOX_DIR,
    PORT: String(port),
  };
}

export const E2E_MAIN_BASE_URL = baseUrlFor(E2E_PORTS.main);
export const E2E_AUTH_DISABLED_BASE_URL = baseUrlFor(E2E_PORTS.authDisabled);
export const E2E_RATE_LIMITED_BASE_URL = baseUrlFor(E2E_PORTS.rateLimited);

export function mainServerEnv(): E2EServerEnv {
  return {
    ...commonEnv(E2E_PORTS.main),
    AUTH_ENABLED: "true",
    // Generous — many specs across many parallel workers each make a
    // handful of real auth requests against this one server inside any
    // given 60s window; this must never trip incidentally. The dedicated
    // rate-limit spec runs against its own server (E2E_PORTS.rateLimited)
    // instead of tuning this one down.
    AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
    AUTH_RATE_LIMIT_MAX: "1000",
    // The DEFAULT (non-customRule) bucket — every page mounts a session
    // check (AccountMenu's useSession()), and Better Auth's own built-in
    // default (10s/100) is easily exceeded by real parallel-worker E2E
    // traffic even though it's fine for production. Accepted trade-off:
    // this deliberately makes the default bucket ~1000x more permissive
    // than production here, so this E2E layer cannot catch a regression
    // that causes excessive get-session/list-sessions polling via a 429 —
    // that class of bug needs to be caught elsewhere (production
    // logs/monitoring, or a narrower dedicated test), not here.
    AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: "60",
    AUTH_RATE_LIMIT_DEFAULT_MAX: "100000",
  };
}

export function authDisabledServerEnv(): E2EServerEnv {
  return {
    ...commonEnv(E2E_PORTS.authDisabled),
    AUTH_ENABLED: "false",
  };
}

export function rateLimitedServerEnv(): E2EServerEnv {
  return {
    ...commonEnv(E2E_PORTS.rateLimited),
    AUTH_ENABLED: "true",
    AUTH_RATE_LIMIT_WINDOW_SECONDS: "30",
    AUTH_RATE_LIMIT_MAX: "3",
    // Only the customRules limit above is under test here — the default
    // bucket (get-session, etc.) should stay generous so it never
    // interferes with this spec's own deliberate 429 on /sign-in/email.
    AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: "60",
    AUTH_RATE_LIMIT_DEFAULT_MAX: "100000",
  };
}
