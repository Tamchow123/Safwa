/**
 * Phase 18 — who is allowed to create an account on this instance
 * (phases-18.md §5 slice 6).
 *
 * Safwa is a personal instance. Its production deployment is reachable by
 * anyone who finds the URL, and every account it creates costs real money on
 * metered services (Neon rows, Resend sends) and real trust (a verified email
 * address, a sync-enabled device). Open sign-up is therefore the bug, not the
 * safeguard — so `SIGNUP_ALLOWED_EMAILS` is REQUIRED in production
 * (`modules/env/server.ts` refuses to start without it) and the deployment
 * fails closed when it is missing rather than defaulting to "anyone".
 *
 * Outside production the variable is optional: leaving it unset keeps sign-up
 * open, which is what local development, the integration suite (which registers
 * dozens of throwaway accounts) and the E2E suites all need.
 *
 * PURE on purpose — no `server-only`, no Better Auth types, no environment
 * reads. `modules/env/server.ts` parses the raw string at validation time and
 * `modules/auth/server.ts` applies the decision inside a `hooks.before`
 * middleware; both call in here, and both are exhaustively testable because
 * neither the parse nor the decision needs a running auth instance.
 */

/**
 * A parsed allowlist, or `null` when none is configured (= sign-up open).
 *
 * `null` and `[]` are deliberately NOT the same thing: an empty result from a
 * non-empty setting means the operator tried to configure something and got
 * nothing, which `parseSignupAllowlist` rejects rather than silently reading as
 * "no allowlist". A configuration mistake must never widen access.
 */
export type SignupAllowlist = readonly string[] | null;

/**
 * The error code the server attaches when it refuses a registration, so the
 * client can say something true instead of "Something went wrong. Please try
 * again." — which would send a person who is simply not permitted to register
 * round the same loop forever.
 *
 * Not one of Better Auth's `BASE_ERROR_CODES`: this refusal is Safwa's own
 * policy, not a condition the library knows about. It lives in this pure module
 * because both sides need it — `modules/auth/server.ts` throws it and
 * `modules/auth/errors.ts` maps it — and neither may import the other.
 */
export const SIGNUP_NOT_ALLOWED_CODE = "SIGNUP_NOT_ALLOWED";

/** Longest address we will accept in the list (RFC 5321's 254-octet path limit). */
const MAX_EMAIL_LENGTH = 254;

/**
 * Normalise an address for comparison: trim, then lower-case the whole thing.
 *
 * Lower-casing the LOCAL part too is technically beyond what RFC 5321 permits
 * (`Me@x.com` and `me@x.com` may be different mailboxes), but it matches how
 * every provider this instance will ever see actually behaves, and — more to
 * the point — how the rest of this codebase already treats email identity: the
 * accounts table has a case-insensitive uniqueness constraint, so `Me@x.com`
 * cannot register alongside `me@x.com` anyway. A case-sensitive allowlist on
 * top of a case-insensitive account table would only ever produce the confusing
 * failure "your address is on the list but sign-up says no".
 */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The shape check applied to each configured entry. Deliberately minimal —
 * exactly one `@`, something on each side of it, and no whitespace. This is
 * not an attempt to validate deliverability; it is a typo tripwire, so a
 * mis-set variable fails at boot rather than silently locking the operator out
 * of their own instance.
 */
function looksLikeEmail(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  return at < value.length - 1;
}

export class SignupAllowlistConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignupAllowlistConfigError";
  }
}

/**
 * Parse the raw `SIGNUP_ALLOWED_EMAILS` value into an allowlist.
 *
 * Unset, empty or whitespace-only → `null` (sign-up open — production rejects
 * this separately, in `assertProductionInvariants`). Otherwise a comma-separated
 * list, each entry trimmed, lower-cased and de-duplicated, order preserved.
 *
 * Throws `SignupAllowlistConfigError` when the value is present but yields
 * nothing usable (e.g. `",,"`) or contains an entry that is not shaped like an
 * address. The error names the 1-based position, never the value: an address is
 * personal data and this message reaches logs. It also does not name the
 * environment variable — `modules/env/server.ts` reports that as the issue path,
 * and repeating it there would read as a stutter.
 */
export function parseSignupAllowlist(raw: string | undefined): SignupAllowlist {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const entries = trimmed.split(",");
  const allowed: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const normalized = normalizeEmail(entry);
    if (normalized.length === 0) {
      throw new SignupAllowlistConfigError(
        `signup allowlist entry ${index + 1} is empty`,
      );
    }
    if (!looksLikeEmail(normalized)) {
      throw new SignupAllowlistConfigError(
        `signup allowlist entry ${index + 1} is not a valid email address`,
      );
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    allowed.push(normalized);
  });

  // No "produced nothing" guard here, and it is worth saying why rather than
  // leaving its absence to be re-derived: `trimmed` is non-empty, so `split`
  // yields at least one part, and every part either throws above or is pushed
  // (the first can never be a duplicate). The array is non-empty by
  // construction. And if that ever stopped holding, an empty list is the SAFE
  // outcome anyway — `isSignupAllowed` refuses everything against `[]`, where
  // only `null` means open.
  return allowed;
}

/**
 * Whether `email` may create an account under `allowlist`.
 *
 * `null` (no allowlist configured) allows everything — the open-sign-up case
 * that only exists outside production. A configured list matches exactly after
 * normalisation; a missing or non-string email is refused.
 *
 * NO plus-address or dot normalisation. `owner+test@gmail.com` does NOT match
 * an allowlisted `owner@gmail.com`. Provider-specific alias rules are a guess
 * about someone else's mail server, and guessing in the permissive direction is
 * the one mistake this module exists to prevent — an operator who wants an
 * alias can list it.
 */
export function isSignupAllowed(
  email: unknown,
  allowlist: SignupAllowlist,
): boolean {
  if (allowlist === null) return true;
  if (typeof email !== "string") return false;
  return allowlist.includes(normalizeEmail(email));
}
