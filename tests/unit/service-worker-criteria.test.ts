import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_POINTER_URL,
  CONTENT_ARTIFACT_PUBLIC_GLOB,
  CONTENT_ARTIFACT_URL_PREFIX,
  learnerUrlForRelease,
} from "@/modules/content/constants";
import { CACHE_NAMES, OFFLINE_FALLBACK_URL } from "@/modules/pwa/cache-rules";
import {
  checkServiceWorkerCriteria,
  DEV_ONLY,
  PROD_ONLY,
} from "@/scripts/verify-service-worker";

/**
 * The service-worker adoption criteria, proved falsifiable.
 *
 * `docs/phases/phases-18.md` §6 makes using `@serwist/turbopack` conditional on
 * four observations, and `pnpm sw:verify` asserts them after every build. The
 * risk that check carries is the one every check carries: that it passes
 * because it cannot fail. So each criterion is broken here, one at a time,
 * against a synthetic build output — and each must be the ONLY one that fails.
 *
 * A real `.next` cannot be used for that: the suite runs before the build in
 * CI, and breaking a real build to test a check is not something to do in a
 * shared tree.
 */
describe("the service-worker adoption criteria", () => {
  let dist: string;

  const write = (path: string, contents: string): void => {
    const full = join(dist, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  };

  /**
   * A worker body carrying every token the wiring check looks for.
   *
   * Built from the same constants the check reads, so a rule added to
   * `cache-rules.ts` does not need remembering here — and a rule REMOVED from
   * `sw.ts` still fails, because the check reads the real bundle.
   */
  const wiredWorker = (manifest: string): string =>
    `var y=${manifest};` +
    Object.values(CACHE_NAMES)
      .map((name) => `new CacheFirst({cacheName:"${name}"});`)
      .join("") +
    `caches.open("x").then(c=>c.add("${OFFLINE_FALLBACK_URL}"));` +
    'self.addEventListener("install",()=>{});';

  const DEFAULT_MANIFEST =
    '[{url:"/_next/static/chunks/abc.js",revision:null},' +
    '{url:"/icons/icon-192.png",revision:null}]';

  /** A build output that satisfies every criterion. */
  const writeGoodBuild = (): void => {
    write("server/app/serwist/sw.js.body", wiredWorker(DEFAULT_MANIFEST));
    write(
      "server/app/serwist/sw.js.meta",
      JSON.stringify({
        headers: {
          "content-type": "application/javascript",
          "service-worker-allowed": "/",
        },
      }),
    );
    // esbuild emits the map beside the worker, so a real build prerenders two
    // paths, not one. The handler's own compiled code lands in a `[path]`
    // directory here — present so the emitted-set check has to ignore it.
    write("server/app/serwist/sw.js.map.body", '{"version":3}');
    write("server/app/serwist/sw.js.map.meta", JSON.stringify({ headers: {} }));
    write("server/app/serwist/[path]/route.js", "export const x = 1;");
    write("static/chunks/react-ish.js", `throw Error("${PROD_ONLY}418")`);
    write("static/chunks/app.js", "console.log(1)");
  };

  const failures = (): string[] =>
    checkServiceWorkerCriteria(dist)
      .filter((check) => !check.ok)
      .map((check) => check.name);

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), "safwa-sw-criteria-"));
  });

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it("passes a build that meets all of them", () => {
    writeGoodBuild();
    expect(failures()).toEqual([]);
  });

  it("fails when no worker was emitted", () => {
    writeGoodBuild();
    rmSync(join(dist, "server", "app", "serwist", "sw.js.body"));
    expect(failures()).toContain("1. the build emits /serwist/sw.js");
  });

  it("fails when the injection point was never replaced", () => {
    // The failure mode that looks most like success: this builds, installs,
    // and precaches nothing.
    writeGoodBuild();
    write("server/app/serwist/sw.js.body", wiredWorker("self.__SW_MANIFEST"));
    expect(failures()).toEqual([
      "2a. the precache manifest was injected, not left as a placeholder",
      "2b. the manifest contains _next/static chunks",
    ]);
  });

  it("fails when a content-release artifact was precached", () => {
    // A precache route outranks any runtime route for the same URL, so this
    // would silently override load.ts's deliberate `cache: "no-store"` on the
    // release pointer and make the phase's content rules unreachable.
    //
    // The fixture URLs come from the content module rather than being typed
    // here, so moving an artifact cannot leave this test passing against a
    // path nothing serves any more.
    for (const url of [
      ACTIVE_POINTER_URL,
      learnerUrlForRelease("safwa-0123456789abcdef"),
    ]) {
      writeGoodBuild();
      write(
        "server/app/serwist/sw.js.body",
        wiredWorker(
          '[{url:"/_next/static/chunks/abc.js",revision:null},' +
            `{url:"${url}",revision:"deadbeef"}]`,
        ),
      );
      expect(failures(), url).toEqual([
        "2c. no content-release artifact is precached",
      ]);
    }
  });

  it("keys that check on the same subtree the exclusion names", () => {
    // The drift this prevents is one-sided and silent: if the exclusion glob
    // and this prefix stop agreeing, the check matches nothing and passes
    // forever while the thing it guards has regressed.
    expect(CONTENT_ARTIFACT_PUBLIC_GLOB).toBe(
      `public${CONTENT_ARTIFACT_URL_PREFIX}**`,
    );
    expect(ACTIVE_POINTER_URL.startsWith(CONTENT_ARTIFACT_URL_PREFIX)).toBe(
      true,
    );
    expect(
      learnerUrlForRelease("safwa-0123456789abcdef").startsWith(
        CONTENT_ARTIFACT_URL_PREFIX,
      ),
    ).toBe(true);
  });

  it("fails when the route emits a file beyond the worker and its map", () => {
    // `dynamicParams: false` bounds the route to what generateStaticParams
    // enumerated — it says nothing about what that set contains. Everything in
    // it is served under `Service-Worker-Allowed: /`, so the set growing is a
    // decision, not a detail.
    writeGoodBuild();
    write("server/app/serwist/sw.js.LICENSE.txt.body", "MIT");
    expect(failures()).toEqual([
      "1b. the route serves only the worker and its source map",
    ]);
  });

  it("fails when the source map stops being emitted", () => {
    writeGoodBuild();
    rmSync(join(dist, "server", "app", "serwist", "sw.js.map.body"));
    expect(failures()).toEqual([
      "1b. the route serves only the worker and its source map",
    ]);
  });

  it("fails when a cache rule never reached the worker bundle", () => {
    // The gap this closes: `modules/pwa/cache-rules.test.ts` passes in full even
    // if `sw.ts` stops importing the rules altogether. Dropping one rule is
    // invisible to the unit suite and visible here.
    for (const dropped of Object.values(CACHE_NAMES)) {
      writeGoodBuild();
      write(
        "server/app/serwist/sw.js.body",
        wiredWorker(DEFAULT_MANIFEST).replace(`"${dropped}"`, '"gone"'),
      );
      expect(failures(), dropped).toEqual([
        "1c. every runtime cache rule reached the worker bundle",
      ]);
    }
  });

  it("fails when the offline page is no longer warmed", () => {
    // A document rule with no fallback still caches, still serves visited
    // pages, and answers an unvisited one with a browser error page — the
    // regression that looks like nothing at all until someone is offline.
    writeGoodBuild();
    write(
      "server/app/serwist/sw.js.body",
      wiredWorker(DEFAULT_MANIFEST).replace(OFFLINE_FALLBACK_URL, "/nothing"),
    );
    expect(failures()).toEqual([
      "1c. every runtime cache rule reached the worker bundle",
    ]);
  });

  it("fails when the manifest carries no build output", () => {
    // A manifest of only public/ assets means the app shell itself is not
    // precached — offline would load icons and nothing else.
    writeGoodBuild();
    write(
      "server/app/serwist/sw.js.body",
      wiredWorker('[{url:"/icons/icon-192.png",revision:null}]'),
    );
    expect(failures()).toEqual([
      "2b. the manifest contains _next/static chunks",
    ]);
  });

  it("fails when the scope header is missing or narrowed", () => {
    writeGoodBuild();
    write("server/app/serwist/sw.js.meta", JSON.stringify({ headers: {} }));
    expect(failures()).toEqual(["3. served with Service-Worker-Allowed: /"]);

    // A worker served from /serwist/ without this header can only control
    // /serwist/, which is to say nothing.
    write(
      "server/app/serwist/sw.js.meta",
      JSON.stringify({ headers: { "service-worker-allowed": "/serwist/" } }),
    );
    expect(failures()).toEqual(["3. served with Service-Worker-Allowed: /"]);
  });

  it("fails when a React development build reached the client bundle", () => {
    writeGoodBuild();
    write("static/chunks/dev-react.js", `throw Error("${DEV_ONLY}")`);
    expect(failures()).toEqual([
      "4a. no React development-only string in the client bundle",
    ]);
  });

  it("fails when no chunk carries the production marker", () => {
    // The half that keeps the check honest: an absence-only test would pass
    // against a bundle containing no React at all.
    writeGoodBuild();
    rmSync(join(dist, "static", "chunks", "react-ish.js"));
    expect(failures()).toEqual([
      "4b. a React production-only marker IS in the client bundle",
    ]);
  });

  it("fails loudly rather than throwing on a corrupt metadata file", () => {
    writeGoodBuild();
    write("server/app/serwist/sw.js.meta", "{not json");
    expect(failures()).toEqual(["3. served with Service-Worker-Allowed: /"]);
  });

  it("reports the two React markers as distinct strings", () => {
    // They are React internals, and the comment on them says a React major
    // upgrade requires re-validating both. If someone ever collapses them into
    // one constant, the pairing this criterion depends on is gone.
    expect(DEV_ONLY).not.toEqual(PROD_ONLY);
    expect(PROD_ONLY).toMatch(/^https:\/\//);
  });
});
