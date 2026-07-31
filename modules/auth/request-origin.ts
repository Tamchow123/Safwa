/**
 * Phase 18.1 — same-origin assertion for this app's own API routes.
 *
 * THE POSTURE THIS SITS INSIDE, because the interesting part is what was
 * already true before this file existed:
 *
 * Safwa sets no `Access-Control-Allow-Origin` header anywhere, on any route.
 * That is not an omission — it is the correct configuration for an app with no
 * cross-origin consumers. A browser will not let foreign JavaScript read a
 * response that does not opt in, so the absence of CORS headers is itself the
 * control. Adding permissive ones is what would be the vulnerability.
 *
 * The session cookie is `SameSite=Lax` (Better Auth's default, unmodified),
 * which is what actually defeats cross-site request forgery here: a cross-site
 * POST, PUT or DELETE does not carry the cookie at all, so a forged write
 * arrives unauthenticated and the route's own guard refuses it.
 *
 * SO WHY THIS FILE. `Lax` has one deliberate gap: it DOES send the cookie on a
 * top-level GET navigation. `/api/sync/pull` is a GET, so a page on another
 * origin can navigate a signed-in learner's browser to it and the request will
 * be authenticated. The attacker cannot READ what comes back — a navigation is
 * not a fetch, and without CORS headers nothing is exposed to their script —
 * so this is not an exfiltration path. It is, however, an authenticated request
 * that a stranger's page caused, which is worth refusing on its own terms.
 *
 * FAIL-SAFE BY CONSTRUCTION. Both checks below refuse only on POSITIVE evidence
 * of a cross-origin request, and allow when the evidence is absent. That
 * direction is deliberate: browsers omit `Origin` on ordinary same-origin GETs
 * and older ones send no `Sec-Fetch-*` at all, so refusing on absence would
 * break real clients to defend against an attacker who cannot forge these
 * headers anyway — both are forbidden header names, settable only by the
 * browser itself. The result adds a control against browsers that send them
 * and changes nothing for the rest.
 */

/** Why a request was refused, for the caller to turn into a response. */
export type OriginVerdict =
  | { sameOrigin: true }
  | { sameOrigin: false; reason: "origin-mismatch" | "cross-site-fetch" };

/** The subset of a request this needs. Keeps the module pure and testable. */
export type OriginHeaders = {
  /** The `Origin` header, if the browser sent one. */
  origin: string | null;
  /** The `Sec-Fetch-Site` header, if the browser sent one. */
  secFetchSite: string | null;
};

/** Reads what {@link assertSameOrigin} needs out of a real request. */
export function originHeadersOf(request: Request): OriginHeaders {
  return {
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  };
}

/**
 * Decide whether `headers` describe a request this origin made of itself.
 *
 * `appOrigin` must be an origin (scheme + host + port), which is what
 * `new URL(env.appUrl).origin` yields — comparing against a full URL with a
 * path would never match, since `Origin` never carries one.
 */
export function assertSameOrigin(
  headers: OriginHeaders,
  appOrigin: string,
): OriginVerdict {
  // `Sec-Fetch-Site: cross-site` is the browser stating plainly that another
  // site initiated this. It is the only signal that catches the top-level
  // GET navigation case, where no Origin header is sent at all.
  //
  // `same-site` is deliberately NOT refused here: it means a sibling subdomain
  // of the same registrable domain, and this app is served from one host, so
  // treating it as hostile would be inventing a threat model the deployment
  // does not have. `none` means a user-initiated navigation (typing the URL,
  // a bookmark), which is not an attack.
  if (headers.secFetchSite === "cross-site") {
    return { sameOrigin: false, reason: "cross-site-fetch" };
  }

  // An Origin that is present and does not match is unambiguous. Browsers send
  // it on every POST/PUT/DELETE, including same-origin ones, so for the
  // state-changing routes this is a real check rather than a hopeful one.
  if (headers.origin !== null && headers.origin !== appOrigin) {
    return { sameOrigin: false, reason: "origin-mismatch" };
  }

  return { sameOrigin: true };
}
