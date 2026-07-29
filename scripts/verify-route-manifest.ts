/**
 * Do the `outputFileTracingIncludes` keys match routes Next actually built?
 *
 * `tests/unit/next-config.test.ts` checks that the committed config agrees with
 * `scripts/content-route-graph.ts`. That is worth having, but it is a check of
 * two derivations against each other: if both spelled a route key in a way
 * Next.js does not recognise, they would agree perfectly and pin nothing, and
 * the first evidence would be a 503 from a deployed route whose content files
 * were never bundled. Phase 18 review REL-005 is exactly that objection.
 *
 * So this runs AFTER `pnpm build` and compares the keys against `.next`'s own
 * app-paths manifest — Next's output, not ours.
 *
 * HOW NEXT MATCHES THESE KEYS. `next/dist/build/collect-build-traces.js` takes
 * each webpack entry name (`app/api/health/route`), runs `normalizeAppPath` on
 * it, and tests every `outputFileTracingIncludes` key against the result with
 * `picomatch(key, { dot: true, contains: true })`. Two consequences that are
 * easy to get wrong and impossible to see from the config alone:
 *  - the entry name starts with `app/`, and `normalizeAppPath` does not strip
 *    it, so the string being matched is `/app/api/health` — NOT `/api/health`;
 *  - `contains: true` means the key matches any substring of that, which is the
 *    only reason a key written as `/api/health` works at all.
 * This reproduces the same normalisation from the manifest and applies the
 * substring rule directly, rather than importing Next internals into a check
 * whose whole job is to be independent of them.
 *
 * WHAT IT DOES NOT CHECK: whether a matched route is statically rendered. Next
 * skips `staticPages` before applying includes, so pinning files to a fully
 * static page would silently do nothing. Every route pinned today is a dynamic
 * Route Handler that reads a database, so this has no bite yet; a future page
 * entry would need `.next/prerender-manifest.json` consulted as well.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import nextConfig from "../next.config";

const MANIFEST = join(
  process.cwd(),
  ".next",
  "server",
  "app-paths-manifest.json",
);

/** picomatch syntax that stops a key from being a plain substring. */
const GLOB_SYNTAX = /[*?[\]{}!+|]/;

/**
 * `/api/health/route` (a manifest key) -> `/app/api/health` (what Next matches
 * `outputFileTracingIncludes` keys against).
 *
 * Mirrors `normalizeAppPath` applied to the webpack entry name, which is the
 * manifest key with an `app` prefix: group segments `(x)` and parallel slots
 * `@x` drop out, a trailing `page`/`route` segment drops out, and the leading
 * `app` survives because nothing removes it.
 */
export function tracingRouteFor(manifestKey: string): string {
  const segments = ["app", ...manifestKey.split("/")].filter(
    (segment) => segment !== "",
  );
  const kept = segments.filter((segment, index) => {
    if (segment.startsWith("(") && segment.endsWith(")")) return false;
    if (segment.startsWith("@")) return false;
    if (
      (segment === "page" || segment === "route") &&
      index === segments.length - 1
    ) {
      return false;
    }
    return true;
  });
  return `/${kept.join("/")}`;
}

export function unmatchedTracingKeys(
  keys: readonly string[],
  manifestKeys: readonly string[],
): string[] {
  const routes = manifestKeys.map(tracingRouteFor);
  return keys.filter((key) => !routes.some((route) => route.includes(key)));
}

function main(): void {
  const keys = Object.keys(nextConfig.outputFileTracingIncludes ?? {});
  if (keys.length === 0) {
    console.log("No outputFileTracingIncludes keys to verify.");
    return;
  }

  if (!existsSync(MANIFEST)) {
    console.error(
      `Cannot verify traced routes: ${MANIFEST} does not exist.\n` +
        "Run `pnpm build` first — this check is meaningless without Next's own output.",
    );
    process.exitCode = 1;
    return;
  }

  const globKeys = keys.filter((key) => GLOB_SYNTAX.test(key));
  if (globKeys.length > 0) {
    console.error(
      "outputFileTracingIncludes keys using glob syntax cannot be verified by " +
        `substring match: ${globKeys.join(", ")}.\n` +
        "Teach scripts/verify-route-manifest.ts the same matcher Next uses " +
        "(picomatch, contains: true) before relying on such a key.",
    );
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<
    string,
    string
  >;
  const manifestKeys = Object.keys(manifest);
  const unmatched = unmatchedTracingKeys(keys, manifestKeys);

  if (unmatched.length > 0) {
    console.error(
      `outputFileTracingIncludes names ${unmatched.length} route(s) Next did not build:\n` +
        unmatched.map((key) => `  - ${key}`).join("\n") +
        "\n\nThese pin nothing. Routes in this build:\n" +
        manifestKeys
          .map((key) => `  ${key} -> ${tracingRouteFor(key)}`)
          .join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `outputFileTracingIncludes OK: all ${keys.length} key(s) match a route in ` +
      `.next/server/app-paths-manifest.json (${manifestKeys.length} routes built).`,
  );
}

// Only when run directly; importing this for tests must not exit the process.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("verify-route-manifest.ts")) {
  main();
}
