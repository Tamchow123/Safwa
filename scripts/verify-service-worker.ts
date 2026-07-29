/**
 * The slice-9 decision-point criteria, kept as a check rather than a memory.
 *
 * `docs/phases/phases-18.md` §6 makes adopting `@serwist/turbopack` conditional
 * on four things being true, "observed and not inferred". They were, once, by
 * hand. That is worth exactly one build: the tooling sits between a Turbopack
 * upgrade and a service worker nobody looks at until they are offline, and
 * every one of these can regress silently — a worker that still builds with an
 * empty manifest is the failure mode that looks most like success.
 *
 * So this runs AFTER `pnpm build`, next to `pnpm routes:verify`, and asserts
 * them against the build's own output.
 *
 * Criterion 3 is checked here from the response metadata Next wrote, which is
 * what it will serve; the offline E2E suite (slice 12) confirms the same header
 * over HTTP from a running server. Both are worth having: this one fails in
 * CI in seconds, that one proves a browser actually accepts the scope.
 *
 * The checks take a dist directory rather than reading `.next` directly, so
 * `tests/unit/service-worker-criteria.test.ts` can prove each one FAILS when
 * its condition is broken. A check nobody has seen fail is not yet a check.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTENT_ARTIFACT_URL_PREFIX } from "../modules/content/constants";
import { CACHE_NAMES, OFFLINE_FALLBACK_URL } from "../modules/pwa/cache-rules";

/**
 * Everything the route is allowed to serve (§6 criterion 1, the "and nothing
 * else" half).
 *
 * `createSerwistRoute`'s `generateStaticParams` returns one entry per esbuild
 * output file, and `dynamicParams: false` makes that set the complete list of
 * paths the route answers — under a response header granting whatever it
 * returns control of the entire origin. `tests/unit/serwist-route.test.ts` pins
 * the `dynamicParams` half; this pins the enumerated set itself, which is the
 * half no unit test can reach (resolving it runs a real esbuild bundle over the
 * built `public/` and `.next/static` trees).
 *
 * The source map is expected: esbuild emits it alongside the worker and it
 * discloses only `modules/pwa/sw.ts`, which is in this repository anyway. If
 * this check ever fails, the question to answer is what the new file is and
 * whether serving it under `Service-Worker-Allowed: /` is intended — then
 * update this list deliberately.
 */
const EMITTED_FILES = ["sw.js", "sw.js.map"];

/**
 * Paired markers for "is this a production React build?" (§6 criterion 4).
 *
 * An absence-only check silently stops discriminating the day React renames or
 * removes the string it looks for — it would pass against a bundle containing
 * no React at all. So one string must be ABSENT and another PRESENT.
 *
 * `DEV_ONLY` is React's full invalid-hook-call message, which the production
 * build replaces with a minified error code. `PROD_ONLY` is the URL those
 * minified codes point at, which only the production build emits.
 *
 * BOTH ARE REACT INTERNALS. A React major upgrade requires re-validating them:
 * build once with each of `NODE_ENV=development` and `NODE_ENV=production` and
 * confirm each string still appears in exactly one of the two.
 */
export const DEV_ONLY =
  "Invalid hook call. Hooks can only be called inside of the body of a function component";
export const PROD_ONLY = "https://react.dev/errors/";

export type Check = { name: string; ok: boolean; detail: string };

/**
 * The paths the route actually prerendered, read from the build's own output.
 *
 * Next writes `<path>.body` + `<path>.meta` per prerendered path, so the
 * `.body` files ARE the set `generateStaticParams` enumerated. The `[path]`
 * directory beside them holds the handler's compiled code, not an output.
 */
function emittedFiles(distDir: string): string[] {
  const directory = join(distDir, "server", "app", "serwist");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".body"))
    .map((name) => name.slice(0, -".body".length))
    .sort();
}

function emittedFilesCheck(distDir: string): Check {
  const emitted = emittedFiles(distDir);
  const expected = [...EMITTED_FILES].sort();
  return {
    name: "1b. the route serves only the worker and its source map",
    ok:
      emitted.length === expected.length &&
      emitted.every((file, index) => file === expected[index]),
    detail:
      emitted.length === 0 ? "nothing emitted" : `emits ${emitted.join(", ")}`,
  };
}

/**
 * Every runtime cache rule, and the offline page, present in the bundle.
 *
 * Names come from `cache-rules.ts` rather than being listed again here, so
 * adding a rule extends this check for free and renaming one cannot leave it
 * asserting a token nothing emits.
 */
function wiringCheck(source: string): Check {
  const expected = [...Object.values(CACHE_NAMES), OFFLINE_FALLBACK_URL];
  const missing = expected.filter((token) => !source.includes(token));
  return {
    name: "1c. every runtime cache rule reached the worker bundle",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${expected.length} present`
        : `MISSING: ${missing.join(", ")}`,
  };
}

function workerChecks(distDir: string): Check[] {
  const body = join(distDir, "server", "app", "serwist", "sw.js.body");
  if (!existsSync(body)) {
    return [
      {
        name: "1. the build emits /serwist/sw.js",
        ok: false,
        detail: `${body} does not exist`,
      },
      emittedFilesCheck(distDir),
    ];
  }
  const source = readFileSync(body, "utf8");
  const entries = [...source.matchAll(/url:\s*"([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
  const staticChunks = entries.filter((url) => url.includes("/_next/static/"));
  const contentEntries = entries.filter((url) =>
    url.startsWith(CONTENT_ARTIFACT_URL_PREFIX),
  );
  const placeholderLeft = source.includes("__SW_MANIFEST");

  return [
    {
      name: "1. the build emits /serwist/sw.js",
      ok: source.length > 0,
      detail: `${source.length} bytes`,
    },
    emittedFilesCheck(distDir),
    // Not one of §6's four criteria — added when slice 10 wired the rules.
    //
    // `modules/pwa/cache-rules.ts` is thoroughly unit-tested, and every one of
    // those tests passes just as well if `sw.ts` stops importing it. The unit
    // suite proves the rules are RIGHT; nothing in it proves they are REACHED.
    // A cache name is a unique token that only appears in the bundle because a
    // handler was constructed with it, so its absence means that rule is gone.
    //
    // Slice 12's offline E2E is the real proof — this is the version that
    // fails in seconds, in CI, on the build that broke it.
    wiringCheck(source),
    // The injection point must have been REPLACED, not merely present: an
    // unreplaced `self.__SW_MANIFEST` still builds, still runs, and precaches
    // nothing at all.
    {
      name: "2a. the precache manifest was injected, not left as a placeholder",
      ok: !placeholderLeft && entries.length > 0,
      detail: `${entries.length} entries, placeholder ${placeholderLeft ? "STILL PRESENT" : "replaced"}`,
    },
    {
      name: "2b. the manifest contains _next/static chunks",
      ok: staticChunks.length > 0,
      detail: `${staticChunks.length} of ${entries.length} entries`,
    },
    // Not one of §6's four criteria — an absence check added after review.
    // A precache route answers from Cache Storage and outranks any runtime
    // route for the same URL, so precaching content artifacts would silently
    // override `modules/content/load.ts`'s deliberate `cache: "no-store"` on
    // the release pointer and make §7's content rules unreachable. The
    // `globIgnores` that prevents it is one line in a route file and easy to
    // lose; the consequence is invisible until someone wonders why a rule
    // never fires. Both name the subtree through the same constant, so this
    // check cannot quietly start matching nothing if it is ever moved.
    {
      name: "2c. no content-release artifact is precached",
      ok: contentEntries.length === 0,
      detail:
        contentEntries.length === 0
          ? "none, as intended"
          : `PRECACHED: ${contentEntries.join(", ")}`,
    },
  ];
}

function scopeHeaderCheck(distDir: string): Check {
  const name = "3. served with Service-Worker-Allowed: /";
  const meta = join(distDir, "server", "app", "serwist", "sw.js.meta");
  if (!existsSync(meta)) {
    return { name, ok: false, detail: `${meta} does not exist` };
  }
  let headers: Record<string, string> | undefined;
  try {
    headers = (
      JSON.parse(readFileSync(meta, "utf8")) as {
        headers?: Record<string, string>;
      }
    ).headers;
  } catch {
    return { name, ok: false, detail: `${meta} is not valid JSON` };
  }
  // Next lower-cases header names in the metadata it writes.
  const value = headers?.["service-worker-allowed"];
  return {
    name,
    ok: value === "/",
    detail: value === undefined ? "header absent" : `"${value}"`,
  };
}

function reactBuildChecks(distDir: string): Check[] {
  const chunks = join(distDir, "static", "chunks");
  if (!existsSync(chunks)) {
    return [
      {
        name: "4. the client bundle is a production React build",
        ok: false,
        detail: `${chunks} does not exist`,
      },
    ];
  }
  const files = readdirSync(chunks).filter((file) => file.endsWith(".js"));
  let dev = 0;
  let prod = 0;
  for (const file of files) {
    const source = readFileSync(join(chunks, file), "utf8");
    if (source.includes(DEV_ONLY)) dev += 1;
    if (source.includes(PROD_ONLY)) prod += 1;
  }
  return [
    {
      name: "4a. no React development-only string in the client bundle",
      ok: dev === 0,
      detail: `${dev} of ${files.length} chunks`,
    },
    {
      name: "4b. a React production-only marker IS in the client bundle",
      ok: prod > 0,
      detail: `${prod} of ${files.length} chunks`,
    },
  ];
}

/** Every §6 criterion, evaluated against a built output directory. */
export function checkServiceWorkerCriteria(distDir: string): Check[] {
  return [
    ...workerChecks(distDir),
    scopeHeaderCheck(distDir),
    ...reactBuildChecks(distDir),
  ];
}

function main(): void {
  const distDir = join(process.cwd(), ".next");
  if (!existsSync(distDir)) {
    console.error(
      "Cannot verify the service worker: .next does not exist. Run `pnpm build` first.",
    );
    process.exitCode = 1;
    return;
  }

  const checks = checkServiceWorkerCriteria(distDir);
  for (const check of checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} service-worker criterion/criteria failed. ` +
        "phases-18.md §6 makes these the condition for using @serwist/turbopack " +
        "at all; if one can no longer hold, the recorded fallback is a " +
        "hand-written runtime-caching worker plus ADR-010 — not a relaxed check.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("verify-service-worker.ts")) {
  main();
}
