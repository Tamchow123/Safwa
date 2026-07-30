import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTENT_ARTIFACT_PUBLIC_GLOB } from "@/modules/content/constants";
import nextConfig from "@/next.config";
import {
  declaredContentFilesystemModules,
  findContentRoutes,
  findFilesystemReaders,
} from "@/scripts/content-route-graph";
import {
  tracingRouteFor,
  unmatchedTracingKeys,
} from "@/scripts/verify-route-manifest";

/**
 * The deployment configuration, asserted rather than assumed (Phase 18).
 *
 * Every part of this file guards the same class of failure: something that is
 * correct in production and unverifiable anywhere else. Security headers are
 * only observable on a real response, and file tracing only matters once the
 * app is a serverless bundle rather than a directory. Neither is exercised by
 * `pnpm dev`, `pnpm test:e2e`, or any other check in this repository, so
 * without these assertions the first evidence of a mistake would be a live
 * request.
 *
 * One limit worth stating: nothing here can confirm that a route KEY is one
 * Next.js itself recognises — this suite runs before any build. `pnpm
 * routes:verify` does that against `.next`'s own manifest, immediately after
 * the build, in CI and in the quality gate.
 */
type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function headerRules(): Promise<HeaderRule[]> {
  const rules = await nextConfig.headers?.();
  expect(rules, "next.config.ts must define headers()").toBeDefined();
  return (rules ?? []) as HeaderRule[];
}

async function headerValue(name: string): Promise<string | undefined> {
  const rules = await headerRules();
  for (const rule of rules) {
    const match = rule.headers.find(
      (header) => header.key.toLowerCase() === name.toLowerCase(),
    );
    if (match) return match.value;
  }
  return undefined;
}

describe("security headers", () => {
  it("applies to every path, not just a subtree", async () => {
    const rules = await headerRules();
    expect(rules.some((rule) => rule.source === "/:path*")).toBe(true);
  });

  it("sets the four headers this phase adds, plus the one it inherits", async () => {
    expect(await headerValue("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(await headerValue("X-Content-Type-Options")).toBe("nosniff");
    expect(await headerValue("X-Frame-Options")).toBe("DENY");
    expect(await headerValue("Strict-Transport-Security")).toBeDefined();
    expect(await headerValue("Permissions-Policy")).toBeDefined();
  });

  it("denies the capabilities the app never uses", async () => {
    // Not an exhaustive list — these are the ones whose absence would be a
    // real privacy regression if a dependency started asking for them.
    const policy = (await headerValue("Permissions-Policy")) ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy, `${feature} must be denied`).toContain(`${feature}=()`);
    }
  });

  it("denies ad-topic inference under both names it has had", async () => {
    // `interest-cohort` was FLoC, which Chrome retired; `browsing-topics` is
    // the Topics API that replaced it. Denying only the retired one reads as
    // protection while denying nothing that actually ships.
    const policy = (await headerValue("Permissions-Policy")) ?? "";
    expect(policy).toContain("interest-cohort=()");
    expect(policy).toContain("browsing-topics=()");
  });

  it("denies clipboard reads, because of the pages next to them", async () => {
    // Sign-in, reset and verification pages are exactly where a learner is
    // likely to have a password or a one-time code on the clipboard.
    const policy = (await headerValue("Permissions-Policy")) ?? "";
    expect(policy).toContain("clipboard-read=()");
  });

  it("keeps HSTS out of the preload list, deliberately", async () => {
    // Preloading is effectively irreversible: browsers ship the list in their
    // binaries. This app has never served a production request, so committing
    // the apex and every future subdomain to HTTPS-only is a promise made too
    // early. If someone adds `preload` later it must be a decision, not a
    // copied snippet — so this test exists to be deleted on purpose.
    const hsts = (await headerValue("Strict-Transport-Security")) ?? "";
    expect(hsts).not.toContain("preload");
    expect(hsts).not.toContain("includeSubDomains");
    const maxAge = /max-age=(\d+)/.exec(hsts);
    expect(maxAge, `no max-age in "${hsts}"`).not.toBeNull();
    // Below ~6 months the header stops being meaningful protection.
    expect(Number(maxAge?.[1])).toBeGreaterThanOrEqual(15_552_000);
  });

  it("ships no Content-Security-Policy, which is a recorded decision", async () => {
    // A CSP for the App Router needs a per-request nonce threaded through
    // middleware plus a worker-src that survives the service worker. Without
    // that, the only policies that "work" are ones asserting nothing. Phase 22
    // owns it. This assertion means adding one has to be deliberate — and
    // whoever does it deletes this test and says why in DEPLOYMENT.md §6.
    expect(await headerValue("Content-Security-Policy")).toBeUndefined();
    expect(
      await headerValue("Content-Security-Policy-Report-Only"),
    ).toBeUndefined();
  });
});

describe("output file tracing", () => {
  const traced = nextConfig.outputFileTracingIncludes ?? {};

  it("pins every route that reads content artifacts from disk", () => {
    // Derived by walking the import graph, not by grepping for an import
    // name — so a route that reaches the loader through three intermediate
    // modules is still caught. If this fails, add the route to
    // outputFileTracingIncludes; do not relax the assertion.
    const expected = findContentRoutes().map((route) => route.route);
    expect(
      expected.length,
      "no content routes found — the graph walk broke",
    ).toBeGreaterThan(0);
    expect(Object.keys(traced).sort()).toEqual([...expected].sort());
  });

  it("names routes that exist on disk, under any filename Next accepts", () => {
    // findContentRoutes() matches route.ts/route.tsx/page.ts/page.tsx (and the
    // .mts/.cts forms tsconfig admits), so checking only for `route.ts` here
    // would pass for the wrong reason the day a page is added.
    //
    // A key inside a route GROUP would not resolve this way — `app/(shell)/…`
    // has segments the served path does not — and none exists today. If one
    // ever does, this fails loudly and the group segments belong in the
    // candidate list; `pnpm routes:verify` is the check that covers it against
    // Next's own manifest either way.
    const filenames = ["route", "page"];
    const extensions = [".ts", ".tsx", ".mts", ".cts"];
    for (const route of Object.keys(traced)) {
      const directory = join(process.cwd(), "app", route.replace(/^\//, ""));
      const candidates = filenames.flatMap((name) =>
        extensions.map((extension) => join(directory, `${name}${extension}`)),
      );
      expect(
        candidates.some((candidate) => existsSync(candidate)),
        `${route} has no route/page file under ${directory}`,
      ).toBe(true);
    }
  });

  it("includes both artifact roots for each, since a release spans them", () => {
    // A release is only loadable if all four of its files are present: three
    // under content-server/ and learner.json under public/content/. Pinning
    // one root without the other fails exactly as loudly as pinning neither.
    //
    // The public-side pattern is asserted through the content module's own
    // constant, which is the same one the service worker excludes from its
    // precache — so a move of that subtree cannot leave next.config.ts naming
    // the old path while everything else names the new one.
    for (const [route, patterns] of Object.entries(traced)) {
      expect(patterns, `${route} must include content-server`).toContain(
        "content-server/**",
      );
      expect(patterns, `${route} must include public/content`).toContain(
        CONTENT_ARTIFACT_PUBLIC_GLOB,
      );
    }
  });
});

describe("the content-route graph itself", () => {
  it("reports how each route reaches the filesystem", () => {
    // Guards against the walk silently degenerating into "every route
    // matches": each result must name a real chain ending at a loader module.
    for (const route of findContentRoutes()) {
      const last = route.via.at(-1);
      expect(last, `${route.route} has no import chain`).toBeDefined();
      expect(last).toMatch(/^modules\/content\/server-/);
    }
  });

  it("does not flag a route that only touches the client content module", () => {
    // modules/content/load.ts is the browser-side loader; it fetches over
    // HTTP and reads no files, so a route using it needs no tracing entry.
    const routes = findContentRoutes().map((route) => route.route);
    expect(routes).not.toContain("/api/auth/[...all]");
  });

  it("accounts for every request-reachable file that reads from disk", () => {
    // The list of LEAF modules is the walk's own hand-maintained input, and it
    // has the same failure mode one level down: a third module that starts
    // reading content artifacts would make a route reaching only it invisible,
    // and the config and the derivation would agree while both missed it.
    //
    // So the scan keys on the READ rather than on the path. Matching a path
    // spelling would miss a loader that receives its directory through a
    // generically-named parameter — a silent false negative in the one place
    // this repository cannot afford one. Keyed on the read, a new reader of any
    // kind fails HERE with a name; if it turns out not to touch content, it
    // goes in NON_CONTENT_FILESYSTEM_READERS with its reason.
    expect(findFilesystemReaders()).toEqual(declaredContentFilesystemModules());
  });
});

/**
 * The walk, exercised against a tree built for the purpose.
 *
 * Everything above runs it over the live repository, which only ever proves it
 * handles the import shapes this app happens to use today. These fixtures pin
 * the behaviours the walk claims: a multi-hop chain, a barrel re-export, a
 * dynamic import, a layout that reaches a loader the page itself never imports,
 * and route-group segments disappearing from the served path.
 */
describe("the walk, against a synthetic tree", () => {
  let root: string;

  const write = (path: string, contents: string): void => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "safwa-route-graph-"));

    // A chain no single-hop check would find: page -> barrel -> mid -> leaf,
    // with the last hop a dynamic import and the first a re-export.
    write("modules/fake/leaf.ts", "export const leaf = 1;\n");
    write(
      "modules/fake/mid.ts",
      'export const load = () => import("./leaf");\n',
    );
    write("modules/fake/barrel.ts", 'export * from "./mid";\n');
    write(
      "app/(group)/thing/page.tsx",
      'import { load } from "@/modules/fake/barrel";\nexport default function Page() { return null; }\n',
    );

    // A page that imports nothing, under a layout that reaches the leaf. Next
    // bundles the layout into the same function, so the route still needs the
    // files pinned — and the import graph alone cannot see that.
    write("app/(shell)/layout.tsx", 'import "@/modules/fake/leaf";\n');
    write(
      "app/(shell)/deep/page.tsx",
      "export default function Page() { return null; }\n",
    );

    // Resolution through a directory index, one more form the walk claims.
    write("modules/other/index.ts", 'export * from "@/modules/fake/barrel";\n');
    write("app/api/indexed/route.ts", 'import "@/modules/other";\n');

    // Reaches nothing. Must not appear in the results.
    write("app/api/plain/route.ts", "export function GET() { return null; }\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const walk = () =>
    findContentRoutes({ root, leaves: ["modules/fake/leaf.ts"] });

  it("finds exactly the routes that reach the leaf", () => {
    expect(walk().map((route) => route.route)).toEqual([
      "/api/indexed",
      "/deep",
      "/thing",
    ]);
  });

  it("follows a barrel re-export and a dynamic import to the leaf", () => {
    const thing = walk().find((route) => route.route === "/thing");
    expect(thing?.via).toEqual([
      "modules/fake/barrel.ts",
      "modules/fake/mid.ts",
      "modules/fake/leaf.ts",
    ]);
  });

  it("reaches a leaf through a layout the page never imports", () => {
    const deep = walk().find((route) => route.route === "/deep");
    expect(deep?.via).toEqual(["modules/fake/leaf.ts"]);
  });

  it("strips route groups from the served path", () => {
    // `app/(group)/thing/page.tsx` is served at /thing, and a config keyed by
    // "/(group)/thing" would pin nothing.
    expect(walk().map((route) => route.route)).not.toContain("/(group)/thing");
  });

  it("leaves a route that reaches nothing alone", () => {
    expect(walk().map((route) => route.route)).not.toContain("/api/plain");
  });
});

/**
 * The post-build check's own arithmetic, without needing a build.
 *
 * `pnpm routes:verify` reads Next's manifest and reproduces the normalisation
 * Next applies before matching `outputFileTracingIncludes` keys. That
 * normalisation is the part that is easy to get quietly wrong, so it is pinned
 * here rather than only exercised by whether a real build happens to pass.
 */
describe("route-manifest normalisation", () => {
  it("keeps the app prefix Next's entry names carry", () => {
    // The string Next matches keys against is the webpack entry name
    // (`app/api/health/route`) normalised — and nothing strips the leading
    // `app`. A key of `/api/health` works only because the match is `contains`.
    expect(tracingRouteFor("/api/health/route")).toBe("/app/api/health");
  });

  it("drops group segments, parallel slots and the leaf filename", () => {
    expect(tracingRouteFor("/(shell)/study/page")).toBe("/app/study");
    expect(tracingRouteFor("/(shell)/@modal/thing/page")).toBe("/app/thing");
    expect(tracingRouteFor("/page")).toBe("/app");
  });

  it("reports a key that matches no built route", () => {
    const manifestKeys = ["/api/health/route", "/(shell)/study/page"];
    expect(unmatchedTracingKeys(["/api/health"], manifestKeys)).toEqual([]);
    expect(unmatchedTracingKeys(["/study"], manifestKeys)).toEqual([]);
    expect(unmatchedTracingKeys(["/api/typo"], manifestKeys)).toEqual([
      "/api/typo",
    ]);
    // The mistake this exists to catch: a key written with the group segment
    // in it, which reads correct and matches nothing.
    expect(unmatchedTracingKeys(["/(shell)/study"], manifestKeys)).toEqual([
      "/(shell)/study",
    ]);
  });
});
