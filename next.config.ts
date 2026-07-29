import type { NextConfig } from "next";

/**
 * A referrer policy, set explicitly rather than left to the browser default
 * (Phase 17 §11, SEC-202-T6b).
 *
 * Several of this app's flows put a single-use secret in a URL: Better Auth's
 * verification, password-reset and delete-account links, and the deletion
 * callback's own nonce (`components/account/pending-account-deletion.ts`). Any
 * cross-origin subresource loaded while such a URL is current would otherwise
 * be able to receive it in a `Referer` header. Modern browsers default to this
 * value, but a default is not a guarantee, and the pages carrying those secrets
 * are exactly the ones where it must not be one.
 */
const REFERRER_POLICY = "strict-origin-when-cross-origin";

/**
 * Security headers applied to every response (Phase 18).
 *
 * There is deliberately NO Content-Security-Policy here. Next's App Router
 * inlines a bootstrap script and streams RSC payloads, so a correct policy
 * needs a per-request nonce threaded through middleware, plus a `worker-src`
 * that survives the service worker arriving in slice 9. A CSP written without
 * that work is either so loose it asserts nothing (`unsafe-inline`) or breaks
 * the app on a route nobody tested. Phase 22 owns it; `docs/DEPLOYMENT.md` §6
 * records the omission rather than letting a future reader assume coverage
 * that was never there.
 *
 * HSTS carries no `preload` and no `includeSubDomains`. Preloading is
 * effectively irreversible — browsers ship the list in their binaries — and
 * this app has never run in production; committing every present and future
 * subdomain of the apex to HTTPS-only before a single real request has been
 * served is a promise made too early. Two years of max-age is the protection;
 * the list can be joined later, deliberately.
 */
const SECURITY_HEADERS = [
  { key: "Referrer-Policy", value: REFERRER_POLICY },
  // Stops a browser second-guessing a Content-Type. Directly relevant here:
  // /content/*.json is learner data served from the same origin as the app,
  // and a sniffed JSON response is the classic way that becomes script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nothing in Safwa is meant to be framed, and its authenticated surfaces
  // (study, settings, account deletion) are exactly what clickjacking targets.
  { key: "X-Frame-Options", value: "DENY" },
  // Deny the capabilities this app never uses, so a future dependency cannot
  // quietly start asking for them. Geolocation/camera/microphone are obvious.
  //
  // Ad-topic inference needs BOTH names: `interest-cohort` was FLoC, which
  // Chrome retired, and `browsing-topics` is the Topics API that replaced it.
  // Denying only the retired one would read as protection while denying
  // nothing that ships today.
  //
  // `clipboard-read` is here because of what sits next to it: sign-in, reset
  // and verification pages, where a learner is likely to have a password or a
  // one-time code on the clipboard at that exact moment.
  {
    key: "Permissions-Policy",
    value:
      "accelerometer=(), autoplay=(), browsing-topics=(), camera=(), clipboard-read=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()",
  },
  // Two years, no preload, no includeSubDomains — see the note above.
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
];

/**
 * Server files that `@vercel/nft` cannot infer, pinned per route (Phase 18).
 *
 * These four routes read content release artifacts from the filesystem at
 * request time: `content-server/release-registry.json` and each release's
 * `validation.json`/`assessment.json`/`checksums.json`, plus the public
 * `learner.json`. Every one of those paths is built at RUNTIME from a release
 * id and `getServerEnv().contentServerDir` — never a static import — so
 * nothing in the module graph tells the tracer they exist.
 *
 * It works today only because the tracer is generous. The failure mode when it
 * stops being generous is not a build error: the deployment succeeds, and then
 * `loadAndVerifyRelease` throws on a missing file and the route answers 503 to
 * real traffic. Pinning them makes the dependency explicit and the failure, if
 * any, a deploy-time one.
 *
 * `public/**` needs pinning too, despite being served by the CDN: Vercel
 * uploads it as static assets, which is a different thing from putting it
 * inside a function's bundle where `readFile(process.cwd() + "/public/...")`
 * can reach it.
 *
 * The route list is exhaustive as of this phase, derived by walking the import
 * graph from every `app/**` route and page to the two modules that touch the
 * filesystem (`modules/content/server-manifests.ts`,
 * `server-release-registry.ts`) rather than by grepping for an import name.
 * A fifth route that reaches either module must be added here — no check
 * enforces that, which is why `docs/DEPLOYMENT.md` §6 records it as a
 * standing obligation.
 */
const CONTENT_ARTIFACTS = ["content-server/**", "public/content/**"];

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/health": CONTENT_ARTIFACTS,
    "/api/sync/push": CONTENT_ARTIFACTS,
    "/api/sync/pull": CONTENT_ARTIFACTS,
    "/api/sync/guest-merge": CONTENT_ARTIFACTS,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
