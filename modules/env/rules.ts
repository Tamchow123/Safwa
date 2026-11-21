/**
 * The parts of the server environment contract that must be readable WITHOUT a
 * valid environment, and without `server-only`.
 *
 * `modules/env/server.ts` owns validation, but it carries `server-only` and
 * validates lazily on first use — right for the app, wrong for a deploy, since
 * by the time lazy validation runs the deployment already exists.
 * `scripts/verify-deploy-preconditions.ts` checks the same contract in plain
 * Node before anything ships. Every rule both of them need lives here, once, so
 * the build-time gate and the runtime validator cannot drift apart and quietly
 * disagree about what a valid production configuration is.
 *
 * Nothing here may gain a dependency, a `server-only` marker, or a side effect.
 * It is imported by a script whose whole job is to run in the situation it
 * exists to diagnose.
 */

/**
 * Production bounds on the four rate-limit tuning variables (Phase 18).
 *
 * `docs/DEPLOYMENT.md` §2 has warned since Phase 15 that these were validated
 * only for positivity, and that copying an E2E- or CI-tuned `.env` into
 * production would "silently and drastically weaken rate limiting with no
 * validation error to catch it at deploy time". `e2e/helpers/e2e-server-env.ts`
 * really does set `AUTH_RATE_LIMIT_DEFAULT_MAX=100000` and
 * `AUTH_RATE_LIMIT_MAX=1000`; these bounds make both structurally unreachable
 * in production rather than merely discouraged in prose.
 *
 * The two MAX ceilings are the security-relevant ones. The window bounds are a
 * pair of sanity limits, and it is worth being precise about which risk each
 * one addresses, because they are not the same risk:
 *  - the FLOOR is security: a one-second window makes any max meaningless,
 *    because the bucket empties faster than an attacker can be slowed down.
 *  - the CEILING is availability: an hour-long window means one fat-fingered
 *    burst locks the instance's only learner out until it expires.
 */
export const PRODUCTION_RATE_LIMIT_BOUNDS = {
  /** Sensitive endpoints (sign-in, sign-up, reset, delete). Default is 5. */
  AUTH_RATE_LIMIT_MAX: { min: 1, max: 20 },
  AUTH_RATE_LIMIT_WINDOW_SECONDS: { min: 30, max: 3600 },
  /**
   * The default bucket covers get-session and friends — read-mostly, hit on
   * every page mount, not brute-forceable — so it legitimately needs far more
   * headroom than the sensitive rules. Better Auth's own default is 100/10s;
   * 1000 leaves room for a busy real session while refusing the E2E 100000.
   */
  AUTH_RATE_LIMIT_DEFAULT_MAX: { min: 1, max: 1000 },
  AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: { min: 5, max: 3600 },
} as const;

export type RateLimitVariable = keyof typeof PRODUCTION_RATE_LIMIT_BOUNDS;

/**
 * The SMTP submission ports this app will speak (Phase 18.2), and therefore the
 * only values `SMTP_PORT` may take. The port is what selects the TLS mode — 465
 * is TLS from the first byte, 587 is STARTTLS that the transport refuses to
 * skip — so any other port would leave no safe mode to select.
 */
export const SMTP_SUBMISSION_PORTS = [465, 587] as const;

export type SmtpSubmissionPort = (typeof SMTP_SUBMISSION_PORTS)[number];

/**
 * `SMTP_PORT` read as a submission port, or `undefined` when it is not one.
 * Exact after trimming — `0x1D1` and `465.0` are not ports anyone means — and
 * shared, so the runtime and the pre-deploy check cannot disagree about it.
 */
export function parseSmtpPort(
  raw: string | undefined,
): SmtpSubmissionPort | undefined {
  const value = raw?.trim();
  return SMTP_SUBMISSION_PORTS.find((port) => String(port) === value);
}

/**
 * A text setting as both validators read it (Phase 18.3): surrounding
 * whitespace removed, and blank meaning unset. Whitespace at either end is the
 * one defect a pasted value commonly carries that is safe to repair — no host,
 * login or sender address ends in a space or a newline.
 *
 * Not for `SMTP_PASSWORD`: a credential's characters belong to its provider,
 * and a mistyped one already fails loudly at send time (`EAUTH`).
 */
export function readSetting(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === "" ? undefined : value;
}

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Why `SMTP_HOST` is not a bare host name, or `undefined` when it is one
 * (Phase 18.3). Expects a value already read through {@link readSetting}.
 *
 * The first production email failed with `code=EDNS` from a malformed host
 * that every check had passed, because they only asked whether it was blank.
 * A host is a DNS name or an IPv4 address and nothing more: a scheme, a port
 * (that is `SMTP_PORT`'s job), a path, quotes or inner whitespace mean the
 * value was pasted with decoration. Each defect gets its own message so the
 * fix is obvious, and no message echoes the value.
 *
 * Deliberately narrower than everything a resolver accepts. An IPv6 literal is
 * refused because its colons cannot be told apart from a port by shape alone,
 * and a trailing dot because it would reach TLS as the server name, which
 * must not carry one; neither is how a mail provider documents its host.
 */
export function smtpHostProblem(host: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(host)) {
    return "must be a bare host name, without a scheme such as smtp:// or https://";
  }
  if (/["'`]/.test(host)) return "must not be quoted";
  if (/\s/.test(host)) return "must not contain whitespace";
  if (host.includes("/")) return "must not contain a path";
  if (host.includes(":")) {
    return "must not contain a colon — the port belongs in SMTP_PORT, and an IPv6 address is not supported";
  }
  const labels = host.split(".");
  const isHostName =
    host.length <= 253 && labels.every((label) => HOST_LABEL.test(label));
  // Every top-level domain starts with a letter (`xn--` ones included), so a
  // last label that does not can only belong to an IPv4 address — and then it
  // must be a well-formed one. This is what refuses `192.0.2.1x` and `999.0.2.1`.
  const isIpv4 = labels.length === 4 && labels.every((l) => IPV4_OCTET.test(l));
  const endsLikeName = /^[A-Za-z]/.test(labels[labels.length - 1]);
  if (!isHostName || (!endsLikeName && !isIpv4)) {
    return "must be a host name such as smtp.example.com, or an IPv4 address";
  }
  return undefined;
}

/** The values `EMAIL_TRANSPORT` may take. */
export const EMAIL_TRANSPORTS = ["console-file", "smtp"] as const;

export type EmailTransportKind = (typeof EMAIL_TRANSPORTS)[number];

/** What `EMAIL_TRANSPORT=smtp` cannot send without (Phase 18.2). */
export const SMTP_REQUIRED_ENV = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "EMAIL_FROM",
] as const;

/** Below this a signing secret is guessable enough to matter. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** The schemes a Postgres connection string may use. */
export const POSTGRES_URL_PREFIXES = ["postgres://", "postgresql://"] as const;

export function looksLikePostgresUrl(value: string): boolean {
  return POSTGRES_URL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * How this app reads a boolean environment variable, in one place.
 *
 * `TRUE`, ` true ` and `True` all mean true; anything else that is not exactly
 * `false` is not a boolean at all and the caller decides what to do about it.
 * Returns `undefined` for "no opinion" — an unset, blank, or unrecognised
 * value — so a validator can apply a default and a pre-deploy check can report
 * a typo rather than silently treating `treu` as false.
 *
 * This exists because the two consumers disagreed once already: a stricter
 * comparison in the deploy script let `SYNC_ENABLED=TRUE` pass a check that the
 * runtime then failed at boot, which is precisely the "found late" outcome the
 * script is meant to prevent.
 */
export function normaliseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised === "true") return true;
  if (normalised === "false") return false;
  return undefined;
}
