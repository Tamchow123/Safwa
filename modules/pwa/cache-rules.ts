/**
 * Which runtime cache rule applies to a request (Phase 18, slice 10).
 *
 * `docs/phases/phases-18.md` §7 is the table these implement, and
 * `modules/pwa/README.md` explains why they live here rather than in `sw.ts`.
 *
 * The predicates are pure and take the same shape Serwist hands a matcher, so
 * each is passed straight through as `matcher:` with no adapter in between —
 * what the test exercises is what the worker runs.
 *
 * WHICH rule a request gets is all this file decides. What may then be written
 * to the two server-rendered caches, and for how long, is `cache-policy.ts` —
 * a separate question with a separate owner, and the one that carries this
 * module's confidentiality guarantee.
 *
 * **Order is part of the rule.** Serwist registers runtime routes in array order
 * and the first match wins, so `RULE_ORDER` below is the contract, not a
 * formatting choice.
 */
import {
  ACTIVE_POINTER_URL,
  CONTENT_ARTIFACT_URL_PREFIX,
} from "@/modules/content/constants";

/**
 * The subset of Serwist's `RouteMatchCallbackOptions` these predicates read.
 *
 * Narrower on purpose: a predicate that cannot see the `event` cannot come to
 * depend on it, and the narrower type is what makes constructing one in a test
 * a two-line affair.
 */
export type RouteContext = {
  url: URL;
  request: Request;
  /** Serwist computes this against the worker's own origin. */
  sameOrigin: boolean;
};

/** Cache names, spelled out rather than left to Serwist's defaults. */
export const CACHE_NAMES = {
  buildAssets: "safwa-build-assets",
  contentPointer: "safwa-content-pointer",
  contentReleases: "safwa-content-releases",
  rsc: "safwa-rsc",
  appShell: "safwa-app-shell",
  documents: "safwa-documents",
  offlineFallback: "safwa-offline-fallback",
} as const;

/**
 * Caches whose contents can be specific to the signed-in account, and which a
 * sign-out must therefore remove.
 *
 * `/api/**` is `NetworkOnly`, so no API response is ever stored — but documents
 * and RSC payloads are server-rendered, and a rendered page can carry account
 * data in its markup. Nothing else here is account-specific: build assets and
 * icons are public files, and content releases are the same immutable
 * vocabulary for every learner.
 *
 * This is the Cache Storage counterpart to CLAUDE.md rule 8's owner-keyed Dexie
 * sweep. It is deliberately a coarse delete rather than an owner-keyed one: a
 * cached document has no owner key to filter on, so the only honest answer is to
 * drop the lot and let the next session refill it.
 */
export const OWNER_SENSITIVE_CACHE_NAMES: readonly string[] = [
  CACHE_NAMES.documents,
  CACHE_NAMES.rsc,
];

/** The page shown for a navigation that is neither cached nor reachable. */
export const OFFLINE_FALLBACK_URL = "/~offline";

/**
 * How long the release pointer may take before the cached copy answers instead.
 *
 * §7.1 is precise about what this buys: not offline content loading, which
 * `modules/content/load.ts`'s Dexie fallback already provides, but a latency
 * bound. `fetchActiveReleasePointer` passes no `AbortSignal`, so on a degraded
 * connection it can hang for as long as the platform allows before that
 * fallback is ever reached. Three seconds turns the hang into an answer.
 */
export const POINTER_NETWORK_TIMEOUT_SECONDS = 3;

/**
 * The same bound, for the two rules a learner actually waits on.
 *
 * `NetworkFirst` without `networkTimeoutSeconds` builds no timeout race at all
 * (serwist only constructs one `if (this._networkTimeoutSeconds)`), so it waits
 * for the fetch to settle before it will look in the cache. On a connection
 * that stalls rather than fails, that is a navigation hanging for as long as
 * the platform's TCP timeout allows while the learner's own cached copy of the
 * page sits unread. Five seconds rather than the pointer's three: a document is
 * a bigger response, and falling back too eagerly on an ordinary slow network
 * would serve stale pages to someone who is online.
 */
export const DOCUMENT_NETWORK_TIMEOUT_SECONDS = 5;
export const RSC_NETWORK_TIMEOUT_SECONDS = 5;

/** Build assets are content-hashed, so their URL changes when they do. */
export const BUILD_ASSET_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The current release plus a rollback and a spare (§7). */
export const RELEASE_CACHE_MAX_ENTRIES = 3;

/**
 * Bounds on the two caches that grow with browsing rather than with releases.
 *
 * The app has fewer than 20 routes, so 32 holds every page a learner can reach
 * with room for query-string variants. An unbounded cache is not a disaster
 * here, but "grows forever on a phone" is not a property to leave to chance.
 */
export const DOCUMENT_CACHE_MAX_ENTRIES = 32;
export const RSC_CACHE_MAX_ENTRIES = 32;

const LEARNER_RELEASE_PATTERN = new RegExp(
  `^${CONTENT_ARTIFACT_URL_PREFIX}releases/[^/]+/learner\\.json$`,
);

/**
 * Authenticated learner data. Never cached, so nothing survives a sign-out that
 * should not have (CLAUDE.md rule 8).
 *
 * Registering `NetworkOnly` is not the same as registering nothing, even though
 * both reach the network today. It is registered FIRST, and first match wins —
 * so a later rule written with a looser matcher cannot start caching `/api`
 * responses by accident. The rule exists to be in the way.
 */
export function isApiRoute({ url, sameOrigin }: RouteContext): boolean {
  return (
    sameOrigin && (url.pathname === "/api" || url.pathname.startsWith("/api/"))
  );
}

/** Content-hashed and immutable by construction, including the font faces. */
export function isImmutableBuildAsset({
  url,
  sameOrigin,
}: RouteContext): boolean {
  return sameOrigin && url.pathname.startsWith("/_next/static/");
}

/** The mutable release pointer: fresh when possible, never a hang. */
export function isReleasePointer({ url, sameOrigin }: RouteContext): boolean {
  return sameOrigin && url.pathname === ACTIVE_POINTER_URL;
}

/** A specific release's learner artifact — immutable once published. */
export function isLearnerRelease({ url, sameOrigin }: RouteContext): boolean {
  return sameOrigin && LEARNER_RELEASE_PATTERN.test(url.pathname);
}

/**
 * Next's React Server Component payloads — the data a client-side navigation
 * fetches instead of a document.
 *
 * Two markers because Next uses both: the `RSC` request header on every flight
 * request, and the `_rsc` cache-busting query parameter it appends to prefetch
 * URLs. Matching only the header would miss a response that is already in the
 * HTTP cache under the parameterised URL.
 */
export function isRscPayload({
  url,
  request,
  sameOrigin,
}: RouteContext): boolean {
  return (
    sameOrigin &&
    (request.headers.get("rsc") !== null || url.searchParams.has("_rsc"))
  );
}

/**
 * The manifest and the icon set.
 *
 * These are unhashed `public/` paths, so the `/_next/static/**` rule does not
 * cover them. They are normally in the precache manifest as well — this rule is
 * what keeps the install hint from rendering a broken icon if they ever are not
 * (§7, last row).
 */
export function isAppShellAsset({ url, sameOrigin }: RouteContext): boolean {
  return (
    sameOrigin &&
    (url.pathname === "/manifest.webmanifest" ||
      url.pathname.startsWith("/icons/"))
  );
}

/**
 * A navigation — the request for a page itself.
 *
 * `mode === "navigate"` rather than `destination === "document"` because it is
 * also the exact condition under which the browser exposes
 * `event.preloadResponse`. `sw.ts` enables navigation preload, and Serwist's
 * strategies consume it inside `StrategyHandler.fetch()`; a rule keyed on
 * anything else would leave those preloads fetched and discarded.
 */
export function isDocumentRequest({
  request,
  sameOrigin,
}: RouteContext): boolean {
  return sameOrigin && request.mode === "navigate";
}

/**
 * The registration order, as data.
 *
 * `sw.ts` builds its `runtimeCaching` array from this so the order it registers
 * and the order the tests assert are the same list. Renaming or reordering here
 * changes the worker's behaviour, which is the point.
 */
export const RULE_ORDER = [
  "api",
  "buildAsset",
  "releasePointer",
  "learnerRelease",
  "rsc",
  "appShell",
  "document",
] as const;

export type RuleName = (typeof RULE_ORDER)[number];

const MATCHERS: Record<RuleName, (context: RouteContext) => boolean> = {
  api: isApiRoute,
  buildAsset: isImmutableBuildAsset,
  releasePointer: isReleasePointer,
  learnerRelease: isLearnerRelease,
  rsc: isRscPayload,
  appShell: isAppShellAsset,
  document: isDocumentRequest,
};

export function matcherFor(rule: RuleName): (context: RouteContext) => boolean {
  return MATCHERS[rule];
}

/**
 * The rule a request would actually get, resolved the way Serwist resolves it.
 *
 * Individual predicates can each be correct while the SET is wrong — two
 * matching the same URL, or none matching one that needs a rule. This resolves
 * first-match-wins over `RULE_ORDER`, so the tests can assert the outcome a
 * request receives rather than the behaviour of one predicate in isolation.
 */
export function ruleFor(context: RouteContext): RuleName | null {
  return RULE_ORDER.find((rule) => MATCHERS[rule](context)) ?? null;
}
