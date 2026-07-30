/**
 * What may be WRITTEN to the server-rendered caches, and how long it may stay
 * (Phase 18, slice 10).
 *
 * `cache-rules.ts` answers which of the seven rules a request gets. This answers
 * the separate question that only arises once a rule has been chosen, and it is
 * separate for a reason: it is where this module's confidentiality guarantee
 * lives, and three of the phase's review findings landed on it. Keeping it in
 * one small purpose-named file means the next person auditing "what can this app
 * cache from a signed-in learner" reads this and nothing else.
 *
 * It applies to the `document` and `rsc` rules only. The others cache public
 * build output — content-hashed chunks, icons, immutable release artifacts —
 * which carries no account data and needs no admission policy.
 */

/**
 * A response worth caching at all.
 *
 * This exists because of a specific Serwist behaviour, not out of caution.
 * `NetworkFirst` prepends its own status guard only
 * `if (!this.plugins.some((p) => "cacheWillUpdate" in p))` — so registering the
 * privacy guard below is exactly what removes it, and `cacheOkAndOpaquePlugin`
 * is not exported to put back.
 *
 * Without this, a transient 500 carrying no cache directives would be stored and
 * later replayed as though it were the page: `Strategy` treats a response as an
 * error only when it is `undefined` or `type === "error"`, so a same-origin 500
 * reads as a perfectly good answer and the `/~offline` fallback never fires.
 *
 * `200 || 0` mirrors the upstream plugin exactly, opaque included, rather than
 * narrowing it — a silent divergence from the library's own semantics is a
 * worse thing to leave behind than an unreachable branch.
 */
export function isGoodResponse(response: Response): boolean {
  return response.status === 200 || response.status === 0;
}

/**
 * A response the server told us not to keep.
 *
 * No URL distinguishes the page that is identical for every visitor from the one
 * rendered for a signed-in learner. The RESPONSE does. Measured against
 * `pnpm start` on this build:
 *
 * - a prerendered route (`/study`) answers `Cache-Control: s-maxage=31536000`
 *   with `x-nextjs-prerender: 1` — public build output;
 * - a dynamically rendered route (`/study/weak`, `/account`) answers
 *   `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
 *
 * `/account` server-renders the learner's name and email. Storing that on a
 * shared device is what CLAUDE.md rule 8 exists to prevent, and the sign-out
 * sweep alone is a poor guard: it does not run when someone closes the tab.
 *
 * A missing header is NOT treated as private. Requiring a positive marker
 * instead was considered and declined — the markers available
 * (`x-nextjs-prerender`, `s-maxage`) were measured from `next start`, this app
 * has never been deployed, and a hosting edge that normalised them away would
 * silently stop caching every document and take offline study with it. That is
 * a worse failure than the one it prevents, and an invisible one.
 * `SERVER_RENDERED_CACHE_MAX_AGE_SECONDS` is the bound on what slips through.
 */
export function isPrivateResponse(response: Response): boolean {
  const directives = (
    response.headers.get("cache-control") ?? ""
  ).toLowerCase();
  return directives.includes("no-store") || directives.includes("private");
}

/**
 * The two above, composed — what `sw.ts` wires as `cacheWillUpdate`.
 *
 * They are separate functions because they answer to different owners: the
 * first restores a library guard, the second is this app's own privacy policy.
 * Whoever changes one should not have to reason about the other.
 */
export function isStorableResponse(response: Response): boolean {
  return isGoodResponse(response) && !isPrivateResponse(response);
}

/**
 * How long a stored server-rendered response may be served — a backstop, not
 * the mechanism.
 *
 * `isStorableResponse` is what keeps account markup out, and it is a write-time
 * guard: nothing personal should be in here to expire. But it rests on Next
 * continuing to mark every personalised route `private`/`no-store`, which
 * nothing in this repository yet asserts against a running server (slice 12
 * owns that), and the 32-entry bounds never evict anything in an app with fewer
 * than 20 routes. So an entry that slipped past the header check would
 * otherwise live forever.
 *
 * Thirty days makes that bound nearly free — but be precise about what it costs,
 * because the clock is not what a reader might assume. `ExpirationPlugin` stamps
 * an entry when it is WRITTEN and does not refresh that stamp on a cache-only
 * read (`maxAgeFrom: "last-used"` is not configured), and it enforces the bound
 * on read as well as on write. So one unbroken 30-day offline stretch expires
 * every document and RSC entry together, **including the start URL** — the
 * installed app would launch straight into `/~offline`, whose "Try again" link
 * points at `/` and would loop back to it until connectivity returns.
 *
 * That is bounded, self-heals on the next successful fetch, and touches no study
 * data: progress lives in Dexie, and the fallback page has its own cache with no
 * expiry. It is the accepted cost of not letting a leaked page live forever.
 */
export const SERVER_RENDERED_CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
