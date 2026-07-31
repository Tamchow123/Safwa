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
 * WHAT COUNTS AS "THIS ORIGIN", AND WHY IT IS NOT JUST THE CONFIGURED URL.
 * The first version of this compared `Origin` against
 * `new URL(env.appUrl).origin` alone. The phase council found the hole: on a
 * platform that mints a hostname per deployment — which is exactly what Vercel
 * preview deployments do — the configured `NEXT_PUBLIC_APP_URL` will not match
 * the host the browser actually reached, and EVERY authenticated request would
 * have been refused with 403. Not degraded: refused. Sync and settings would be
 * entirely broken on every preview, and it would look like an auth bug rather
 * than a configuration one.
 *
 * So the request's OWN host counts as same-origin too. That is not a weakening
 * — "did this request come from the origin it was addressed to" is the actual
 * definition of same-origin, and it needs no configuration to be right. `Host`
 * (and `X-Forwarded-Host`, which the platform sets) cannot be forged by a
 * browser any more than `Origin` can: script cannot set either. An attacker who
 * could set both arbitrarily is not making a cross-site browser request at
 * all — they are speaking HTTP directly, where they have their own session or
 * none, and where this check was never the defence.
 *
 * THE TOPOLOGY THIS ASSUMES. Trusting `X-Forwarded-Host`/`X-Forwarded-Proto`
 * is safe under the deployment described in `docs/DEPLOYMENT.md` §3: Vercel
 * functions sit directly behind Vercel's own edge, with no CDN or WAF in
 * front, so those headers are set by the platform rather than passed through
 * from a client. This is the same assumption §10 already records for
 * `x-forwarded-for` and Better Auth's rate limiter, written here too because
 * the next person to change the topology will grep for one of them, not both.
 * If a CDN is ever added in front of Vercel, re-verify that it strips or
 * rewrites client-supplied `X-Forwarded-Host` before this derivation keeps
 * being trusted.
 *
 * FAIL-SAFE BY CONSTRUCTION. Both signals refuse only on POSITIVE evidence of a
 * cross-origin request, and allow when the evidence is absent. That direction is
 * deliberate: browsers omit `Origin` on ordinary same-origin GETs and older ones
 * send no `Sec-Fetch-*` at all, so refusing on absence would break real clients
 * to defend against an attacker who cannot forge these headers anyway — both are
 * forbidden header names, settable only by the browser itself. The result adds a
 * control against browsers that send them and changes nothing for the rest.
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
  /**
   * The origin the request was ADDRESSED to, derived from the request itself
   * rather than from configuration. `null` when it cannot be determined.
   */
  requestOrigin: string | null;
};

/**
 * The origin this request was addressed to, from the request itself.
 *
 * `X-Forwarded-Host` first, because that is what a platform proxy sets to the
 * public hostname when the internal `Host` is something else.
 * `X-Forwarded-Proto` likewise, falling back to the URL's own protocol — on
 * Vercel the function sees an internal `http://` URL while the browser used
 * `https://`, and comparing those would fail on the scheme alone.
 */
export function requestOriginOf(request: Request): string | null {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host === null || host === "") return null;
  // A comma-separated chain can arrive through multiple proxies; the first hop
  // is the one the browser spoke to.
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const proto =
    forwardedProto?.split(",")[0]?.trim() ??
    new URL(request.url).protocol.replace(":", "");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    // A malformed host header cannot be turned into an origin. Returning null
    // means "no evidence", not "allow" — the configured origin is still
    // checked, and a mismatching Origin is still refused.
    return null;
  }
}

/** Reads what {@link verifySameOrigin} needs out of a real request. */
export function originHeadersOf(request: Request): OriginHeaders {
  return {
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    requestOrigin: requestOriginOf(request),
  };
}

/**
 * Decide whether `headers` describe a request this origin made of itself.
 *
 * Named `verify…`, not `assert…`: it RETURNS a verdict rather than throwing.
 * An `assert` prefix conventionally means "throws on failure", and a caller
 * who believed that could drop the return value and silently admit every
 * cross-origin request.
 *
 * `appOrigin` must be an origin (scheme + host + port), which is what
 * `new URL(env.appUrl).origin` yields — comparing against a full URL with a
 * path would never match, since `Origin` never carries one.
 */
export function verifySameOrigin(
  headers: OriginHeaders,
  appOrigin: string,
): OriginVerdict {
  // `Sec-Fetch-Site: cross-site` is the browser stating plainly that another
  // site initiated this. It is the only signal that catches the top-level GET
  // navigation case, where no Origin header is sent at all.
  //
  // `same-site` is deliberately NOT refused: it means a sibling subdomain of
  // the same registrable domain, and this app is served from one host, so
  // treating it as hostile would invent a threat model the deployment does not
  // have. `none` means a user-initiated navigation (typing the URL, a
  // bookmark), which is not an attack.
  if (headers.secFetchSite === "cross-site") {
    return { sameOrigin: false, reason: "cross-site-fetch" };
  }

  // An Origin that is present and matches NEITHER the configured app origin
  // NOR the origin this request was actually addressed to is unambiguous.
  // Browsers send Origin on every POST/PUT/DELETE, including same-origin ones,
  // so for the state-changing routes this is a real check, not a hopeful one.
  if (headers.origin !== null) {
    const permitted = [appOrigin, headers.requestOrigin].filter(
      (candidate): candidate is string => candidate !== null,
    );
    if (!permitted.includes(headers.origin)) {
      return { sameOrigin: false, reason: "origin-mismatch" };
    }
  }

  return { sameOrigin: true };
}
