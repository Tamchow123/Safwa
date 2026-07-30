/**
 * Pre-deploy precondition check (Phase 18).
 *
 * `docs/DEPLOYMENT.md` §2 explains why this exists: `getServerEnv()` validates
 * LAZILY, on first use, so a misconfigured production deployment does not
 * refuse to start. It comes up healthy-looking, and the first request that
 * touches auth, the database or email throws. `GET /api/health` is the runtime
 * signal for that, but the runtime is a late place to learn it — by then the
 * deployment exists and, depending on the platform's cutover, may already be
 * taking traffic.
 *
 * So this runs BEFORE the deploy, against the same variables production will
 * see, and reports every problem at once rather than the first.
 *
 * THE RULES ARE NOT A SECOND COPY. Every value and shape it enforces comes from
 * `modules/env/rules.ts`, which exists so this script and
 * `modules/env/server.ts` cannot drift apart — that module is dependency-free
 * and carries no `server-only` marker, so importing it here costs nothing and
 * needs no valid environment. `tests/unit/deploy-preconditions.test.ts` holds
 * the two enforcement points against each other directly: it drives the REAL
 * runtime validator over a table of environments and asserts this script is
 * never the more permissive of the two.
 *
 * FAILURES VS WARNINGS. A failure fails the build. A warning is printed and
 * does not. The distinction is not decoration: the runtime permits
 * `ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION=true` outright, so treating it as
 * fatal here would mean the documented escape hatch could never get a build
 * through `vercel.json`'s gate — an escape hatch that blocks the thing it
 * exists to allow.
 *
 * It checks configuration only. It opens no connection, sends no email, and
 * makes no paid API call — a precondition check that costs money or mutates
 * state is one people stop running. It also never echoes a value, only the
 * name of the variable and what is wrong with it, so it is safe in a CI log.
 * Nothing it calls may throw: a stack trace here would hide every other
 * problem in the same run.
 */
import { parseSignupAllowlist } from "../modules/auth/signup-allowlist";
import {
  looksLikePostgresUrl,
  MIN_PRODUCTION_SECRET_LENGTH,
  normaliseBooleanFlag,
  PRODUCTION_RATE_LIMIT_BOUNDS,
} from "../modules/env/rules";

export type PreconditionFailure = {
  variable: string;
  problem: string;
};

/** Worth printing, never worth blocking a deploy over. */
export type PreconditionWarning = {
  variable: string;
  note: string;
};

export type PreconditionReport = {
  failures: PreconditionFailure[];
  warnings: PreconditionWarning[];
};

/**
 * Variables with no safe default: production cannot come up without them.
 *
 * Exported because `tests/unit/deploy-preconditions.test.ts` asserts this
 * equals `requiredServerEnvKeys()` — the set derived from the runtime Zod
 * schema itself. Adding a required variable to the schema without adding it
 * here fails that test rather than a production request.
 */
export const REQUIRED_PRODUCTION_ENV = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;

/**
 * Every problem with `env`. Empty failures means the environment is deployable
 * as far as configuration alone can tell.
 */
export function checkDeployPreconditions(
  env: Record<string, string | undefined>,
): PreconditionReport {
  const failures: PreconditionFailure[] = [];
  const warnings: PreconditionWarning[] = [];
  const fail = (variable: string, problem: string): void => {
    failures.push({ variable, problem });
  };
  const warn = (variable: string, note: string): void => {
    warnings.push({ variable, note });
  };

  for (const variable of REQUIRED_PRODUCTION_ENV) {
    if (!env[variable]?.trim()) fail(variable, "is required but unset or blank");
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl && !looksLikePostgresUrl(databaseUrl)) {
    // Same shape check the runtime schema applies, from the same helper.
    fail("DATABASE_URL", "must be a postgres:// or postgresql:// URL");
  }

  const secret = env.BETTER_AUTH_SECRET;
  if (secret !== undefined && secret.trim().length > 0) {
    if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      // Report the length, never the value — here or anywhere below.
      fail(
        "BETTER_AUTH_SECRET",
        `is ${secret.length} characters; production needs at least ${MIN_PRODUCTION_SECRET_LENGTH}`,
      );
    }
  }

  for (const variable of ["BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"] as const) {
    const raw = env[variable];
    if (!raw?.trim()) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      fail(variable, "is not a valid absolute URL");
      continue;
    }
    if (url.protocol !== "https:") {
      fail(variable, `must be https in production, got ${url.protocol}//`);
    }
  }

  // The allowlist is the difference between a personal instance and an open
  // one. modules/env/server.ts fails closed on it; so does this. The parser
  // THROWS on a malformed entry (a trailing comma is the everyday case), and
  // an uncaught throw here would abort the run and hide every problem below.
  let allowlist: readonly string[] | null = null;
  try {
    allowlist = parseSignupAllowlist(env.SIGNUP_ALLOWED_EMAILS);
  } catch (error) {
    // The parser's messages name a position, never an address.
    fail("SIGNUP_ALLOWED_EMAILS", (error as Error).message);
  }
  if (failures.every((failure) => failure.variable !== "SIGNUP_ALLOWED_EMAILS")) {
    if (allowlist === null) {
      fail(
        "SIGNUP_ALLOWED_EMAILS",
        "is unset — production fails closed, and an open sign-up on a personal instance is the bug (DEPLOYMENT.md §2)",
      );
    } else if (allowlist.length === 0) {
      fail("SIGNUP_ALLOWED_EMAILS", "is set but lists no address");
    }
  }

  for (const [variable, bound] of Object.entries(PRODUCTION_RATE_LIMIT_BOUNDS)) {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === "") continue; // Defaults are in bounds.
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      fail(variable, `must be an integer, got ${JSON.stringify(raw)}`);
      continue;
    }
    if (value < bound.min || value > bound.max) {
      fail(
        variable,
        `is ${value}, outside the production bound ${bound.min}-${bound.max} (DEPLOYMENT.md §2)`,
      );
    }
  }

  // Email is a hard dependency, not an optional integration: sign-up sets
  // requireEmailVerification, and an unverified account cannot sync. A
  // production deploy on the console-file transport writes verification links
  // to a directory nobody reads, which looks like "sign-up is broken".
  const transport = env.EMAIL_TRANSPORT;
  const devTransportAllowed = normaliseBooleanFlag(
    env.ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION,
  );
  if (env.ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION?.trim() && devTransportAllowed === undefined) {
    fail(
      "ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION",
      'must be "true" or "false"',
    );
  }
  if (transport !== "resend") {
    if (devTransportAllowed === true) {
      // A warning, not a failure — the runtime permits exactly this, and a
      // gate stricter than the thing it gates is a gate nobody can satisfy.
      warn(
        "ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION",
        "is enabled, so verification emails will be written to a local directory instead of sent. Intended only for a smoke test — real sign-up cannot complete.",
      );
    } else {
      fail(
        "EMAIL_TRANSPORT",
        `must be "resend" in production, got ${JSON.stringify(transport ?? "(unset)")}`,
      );
    }
  } else {
    if (!env.RESEND_API_KEY?.trim()) {
      fail("RESEND_API_KEY", 'is required when EMAIL_TRANSPORT is "resend"');
    }
    if (!env.EMAIL_FROM?.trim()) {
      fail("EMAIL_FROM", 'is required when EMAIL_TRANSPORT is "resend"');
    }
  }

  // Rejected by assertProductionInvariants too, but the whole point of this
  // script is to say so before the deploy rather than on first request. Both
  // flags are read through the shared normaliser so an oddly-cased `TRUE`
  // cannot pass here and then fail at boot.
  for (const variable of ["SYNC_ENABLED", "AUTH_ENABLED"] as const) {
    const raw = env[variable];
    if (raw?.trim() && normaliseBooleanFlag(raw) === undefined) {
      fail(variable, 'must be "true" or "false"');
    }
  }
  const syncEnabled = normaliseBooleanFlag(env.SYNC_ENABLED) ?? true;
  const authEnabled = normaliseBooleanFlag(env.AUTH_ENABLED) ?? true;
  if (syncEnabled && !authEnabled) {
    fail(
      "SYNC_ENABLED",
      "is enabled while AUTH_ENABLED is false — sync is meaningless without an authenticated account",
    );
  }

  return { failures, warnings };
}

export function formatFailures(
  failures: readonly PreconditionFailure[],
): string {
  return failures
    .map((failure) => `  - ${failure.variable} ${failure.problem}`)
    .join("\n");
}

export function formatWarnings(
  warnings: readonly PreconditionWarning[],
): string {
  return warnings
    .map((warning) => `  - ${warning.variable} ${warning.note}`)
    .join("\n");
}

function main(): void {
  const { failures, warnings } = checkDeployPreconditions(process.env);

  if (warnings.length > 0) {
    console.warn(
      `Deploy preconditions — ${warnings.length} warning(s):\n${formatWarnings(warnings)}`,
    );
  }

  if (failures.length === 0) {
    console.log(
      "Deploy preconditions OK: required variables present, URLs https, " +
        "sign-up allowlist set, rate limits within production bounds, email " +
        "transport configured.",
    );
    return;
  }
  console.error(
    `Deploy preconditions FAILED (${failures.length} problem(s)):\n` +
      `${formatFailures(failures)}\n\n` +
      "See docs/DEPLOYMENT.md §2. Nothing was deployed.",
  );
  process.exitCode = 1;
}

// Only when run directly; importing this for tests must not exit the process.
if (
  process.argv[1]?.replace(/\\/g, "/").endsWith("verify-deploy-preconditions.ts")
) {
  main();
}
