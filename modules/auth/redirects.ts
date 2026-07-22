/**
 * Safe-redirect validation (Phase 15, phases-15.md §33). Every auth
 * callback/return URL must be validated before use: allow only a
 * same-origin relative path, or fall back to a small explicit default.
 * Reject external origins, protocol-relative URLs, javascript: URLs,
 * encoded open redirects (including doubly-encoded ones), backslash
 * variants, and excessively long values.
 */

export const DEFAULT_SAFE_REDIRECT = "/";
const MAX_REDIRECT_LENGTH = 512;
// Bounds the decode loop below: a legitimate value (even doubly-encoded
// by an intermediary) fully resolves in far fewer than this many passes;
// anything that doesn't stabilise by then is treated as unsafe rather
// than risk an under-decoded payload slipping through.
const MAX_DECODE_ITERATIONS = 5;

/**
 * True only for a string that is unambiguously a same-origin relative
 * path: starts with a single "/" (never "//", which browsers resolve as
 * protocol-relative to an arbitrary host), contains no backslash (some
 * URL parsers/browsers normalise "\" to "/", turning "/\evil.com" into a
 * protocol-relative URL after the fact), and — parsed against a fixed
 * dummy origin — resolves to that SAME origin with no scheme other than
 * http/https (rejects "javascript:", "data:", etc., which `new URL`
 * would otherwise parse as an absolute URL and ignore the base entirely).
 */
function isSafeRelativePath(value: string): boolean {
  if (value.includes("\\")) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  try {
    const parsed = new URL(value, "http://localhost");
    return parsed.protocol === "http:" && parsed.host === "localhost";
  } catch {
    return false;
  }
}

/**
 * Resolves `candidate` to a safe same-origin relative path, or
 * `DEFAULT_SAFE_REDIRECT` if it fails any check. Repeatedly percent-
 * decodes and re-validates (bounded by `MAX_DECODE_ITERATIONS`) rather
 * than decoding just once — a DOUBLY-encoded open redirect (e.g.
 * `/%252F%252Fevil.com`, which decodes once to the still-encoded
 * `/%2F%2Fevil.com` and only reveals `//evil.com` on a SECOND decode)
 * would otherwise look safe after a single pass and be returned
 * unchanged, becoming exploitable the moment any downstream consumer
 * decodes it again before navigating.
 */
export function resolveSafeRedirect(
  candidate: string | null | undefined,
): string {
  if (!candidate) return DEFAULT_SAFE_REDIRECT;
  if (candidate.length > MAX_REDIRECT_LENGTH) return DEFAULT_SAFE_REDIRECT;

  let current = candidate;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
    if (!isSafeRelativePath(current)) return DEFAULT_SAFE_REDIRECT;

    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return DEFAULT_SAFE_REDIRECT;
    }
    if (decoded === current) {
      // Fully decoded, and every layer along the way was safe.
      return candidate;
    }
    current = decoded;
  }

  return DEFAULT_SAFE_REDIRECT;
}
