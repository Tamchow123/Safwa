/**
 * Outbound email-link safety (Phase 15, phases-15.md §39) — a distinct
 * concern from template rendering (modules/email/templates.ts): confirming
 * a link embedded in an email points at the app's own canonical origin,
 * never off-origin, regardless of what constructed it.
 */

export class UnsafeEmailLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeEmailLinkError";
  }
}

/**
 * Strips everything after the path (query string, fragment) so a
 * diagnostic message can reference a URL without ever repeating the live
 * verification/reset/delete-account token it carries as a query
 * parameter — callers of `sendEmail` may log this error's `.message`
 * verbatim, and a token is exactly the kind of value that must never
 * reach a log store.
 */
function redactForDiagnostics(url: string): string {
  const queryOrFragmentIndex = url.search(/[?#]/);
  return queryOrFragmentIndex === -1
    ? url
    : `${url.slice(0, queryOrFragmentIndex)}[redacted]`;
}

/**
 * Confirms `url`'s origin exactly matches `canonicalOrigin` (the
 * configured `NEXT_PUBLIC_APP_URL`/`BETTER_AUTH_URL` origin) — an email
 * link must never point off-origin, regardless of what constructed it.
 */
export function assertSameOrigin(url: string, canonicalOrigin: string): void {
  let parsedUrl: URL;
  let parsedCanonical: URL;
  try {
    parsedUrl = new URL(url);
    parsedCanonical = new URL(canonicalOrigin);
  } catch {
    throw new UnsafeEmailLinkError(
      `Malformed email link URL: ${redactForDiagnostics(url)}`,
    );
  }
  if (parsedUrl.origin !== parsedCanonical.origin) {
    throw new UnsafeEmailLinkError(
      `Email link origin (${parsedUrl.origin}) does not match the canonical app origin (${parsedCanonical.origin})`,
    );
  }
}
