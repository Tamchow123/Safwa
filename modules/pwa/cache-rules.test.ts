import { describe, expect, it } from "vitest";

import {
  ACTIVE_POINTER_URL,
  CONTENT_ARTIFACT_URL_PREFIX,
  learnerUrlForRelease,
} from "@/modules/content/constants";
import {
  CACHE_NAMES,
  DOCUMENT_NETWORK_TIMEOUT_SECONDS,
  isApiRoute,
  isDocumentRequest,
  OWNER_SENSITIVE_CACHE_NAMES,
  POINTER_NETWORK_TIMEOUT_SECONDS,
  RSC_NETWORK_TIMEOUT_SECONDS,
  RULE_ORDER,
  ruleFor,
  type RouteContext,
  type RuleName,
} from "@/modules/pwa/cache-rules";

/**
 * The runtime cache rules, asserted as a table rather than one predicate at a
 * time.
 *
 * `docs/phases/phases-18.md` §7 is a table of route classes, and the failure
 * that table has is not "a predicate is wrong" — it is "two predicates match
 * the same request and the wrong one is first", or "a route class matches
 * nothing at all". Neither is visible from testing predicates in isolation, so
 * almost everything here goes through `ruleFor`, which resolves first-match-wins
 * over `RULE_ORDER` exactly as Serwist does.
 *
 * The URLs come from the content module's own constants wherever one exists, so
 * moving an artifact fails here rather than leaving a rule that quietly matches
 * a path nothing serves.
 */
const ORIGIN = "https://safwa.example";

function context(
  path: string,
  init: { headers?: Record<string, string>; mode?: RequestMode } = {},
): RouteContext {
  const url = new URL(path, ORIGIN);
  // A real `Request`, with the mode shadowed as an own property. `mode:
  // "navigate"` cannot be passed to the constructor — the spec reserves it for
  // requests the browser itself creates — so this is the only way to build the
  // one input the document rule exists for. Everything else, headers included,
  // is genuine; a stand-in object would let a predicate reading something the
  // stand-in lacks pass here and fail in a worker.
  const request = new Request(url, { headers: init.headers });
  Object.defineProperty(request, "mode", { value: init.mode ?? "cors" });
  return { url, request, sameOrigin: url.origin === ORIGIN };
}

const rule = (
  path: string,
  init?: { headers?: Record<string, string>; mode?: RequestMode },
): RuleName | null => ruleFor(context(path, init));

describe("the runtime cache rule each request class gets", () => {
  it("gives every route class in §7 a rule", () => {
    expect(rule("/api/sync/push")).toBe("api");
    expect(rule("/_next/static/chunks/main.js")).toBe("buildAsset");
    expect(rule(ACTIVE_POINTER_URL)).toBe("releasePointer");
    expect(rule(learnerUrlForRelease("safwa-0123456789abcdef"))).toBe(
      "learnerRelease",
    );
    expect(rule("/study", { headers: { rsc: "1" } })).toBe("rsc");
    expect(rule("/manifest.webmanifest")).toBe("appShell");
    expect(rule("/icons/icon-192.png")).toBe("appShell");
    expect(rule("/study", { mode: "navigate" })).toBe("document");
  });

  it("caches nothing under /api, by any route", () => {
    // The rule that matters most, so it is asserted as an exclusion rather
    // than as an equality: whatever else changes, no /api request may end up
    // on a caching handler.
    for (const path of [
      "/api",
      "/api/health",
      "/api/sync/pull",
      "/api/sync/guest-merge",
      "/api/auth/session",
      "/api/account/export?format=json",
    ]) {
      expect(rule(path), path).toBe("api");
    }
    // Including when it carries the markers other rules key on. An RSC-looking
    // header on an API request must not move it onto a cache.
    expect(rule("/api/health", { headers: { rsc: "1" } })).toBe("api");
    expect(rule("/api/health?_rsc=abc123")).toBe("api");
  });

  it("does not mistake a lookalike path for an API route", () => {
    expect(rule("/apiary")).not.toBe("api");
    expect(rule("/study/api")).not.toBe("api");
  });

  it("matches an RSC payload by either marker Next uses", () => {
    // The header is on every flight request; the query parameter is what Next
    // appends to prefetch URLs. Matching only one leaves the other uncached.
    expect(rule("/library", { headers: { rsc: "1" } })).toBe("rsc");
    expect(rule("/library?_rsc=8f2a1c")).toBe("rsc");
    expect(rule("/library")).toBeNull();
  });

  it("treats a navigation as a document even when it carries a query", () => {
    expect(rule("/study/mc?deck=weak", { mode: "navigate" })).toBe("document");
  });

  it("puts the release pointer ahead of nothing else that could claim it", () => {
    // Both content rules sit under the same prefix, and a learner artifact URL
    // must not fall through to the pointer's NetworkFirst (which would cache a
    // multi-megabyte release under a 3s timeout) or the reverse.
    expect(ACTIVE_POINTER_URL.startsWith(CONTENT_ARTIFACT_URL_PREFIX)).toBe(
      true,
    );
    expect(rule(`${CONTENT_ARTIFACT_URL_PREFIX}releases/r1/learner.json`)).toBe(
      "learnerRelease",
    );
    expect(
      rule(`${CONTENT_ARTIFACT_URL_PREFIX}releases/learner.json`),
    ).toBeNull();
    expect(
      rule(`${CONTENT_ARTIFACT_URL_PREFIX}releases/r1/checksums.json`),
    ).toBeNull();
  });

  it("leaves cross-origin requests to the network", () => {
    // Every predicate is same-origin guarded. Without that, a rule reading only
    // the pathname would happily cache `https://elsewhere.example/api/...`.
    const foreign = new URL("https://elsewhere.example/_next/static/x.js");
    expect(
      ruleFor({
        url: foreign,
        request: new Request(foreign),
        sameOrigin: false,
      }),
    ).toBeNull();
  });

  it("leaves an ordinary same-origin request with no rule at all", () => {
    // Not everything needs one. A request that matches nothing goes to the
    // network untouched, which is the correct outcome and not a gap.
    expect(rule("/robots.txt")).toBeNull();
    expect(rule("/content/releases/r1/assessment.json")).toBeNull();
  });
});

describe("the rule set as a whole", () => {
  it("registers /api first, so nothing added later can outrank it", () => {
    expect(RULE_ORDER[0]).toBe("api");
  });

  it("resolves every rule name in the order, with no unreachable entry", () => {
    // A rule that no request can reach is worse than no rule: it reads as
    // coverage. Each name must be the answer for at least one request.
    const reachable = new Set<RuleName | null>([
      rule("/api/health"),
      rule("/_next/static/chunks/main.js"),
      rule(ACTIVE_POINTER_URL),
      rule(learnerUrlForRelease("safwa-0123456789abcdef")),
      rule("/study", { headers: { rsc: "1" } }),
      rule("/icons/icon-192.png"),
      rule("/study", { mode: "navigate" }),
    ]);
    expect([...RULE_ORDER].sort()).toEqual(
      [...reachable].filter((name) => name !== null).sort(),
    );
  });

  it("names a distinct cache per rule, so eviction policies cannot collide", () => {
    const names = Object.values(CACHE_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it("clears the two caches that can hold account markup, and only those", () => {
    // Build assets, icons and content releases are identical for every learner,
    // so clearing them on sign-out would cost an offline learner their app
    // shell to protect nothing.
    expect([...OWNER_SENSITIVE_CACHE_NAMES].sort()).toEqual(
      [CACHE_NAMES.documents, CACHE_NAMES.rsc].sort(),
    );
    expect(OWNER_SENSITIVE_CACHE_NAMES).not.toContain(CACHE_NAMES.buildAssets);
    expect(OWNER_SENSITIVE_CACHE_NAMES).not.toContain(
      CACHE_NAMES.contentReleases,
    );
  });
});

describe("the network timeouts", () => {
  it("bounds the two rules a learner waits on, not just the pointer", () => {
    // `NetworkFirst` with no `networkTimeoutSeconds` builds no timeout race at
    // all, so a stalled connection blocks the navigation instead of falling
    // back to the cached page sitting right there.
    expect(POINTER_NETWORK_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(DOCUMENT_NETWORK_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(RSC_NETWORK_TIMEOUT_SECONDS).toBeGreaterThan(0);
  });

  it("gives a document longer than the pointer, because it is a bigger response", () => {
    expect(DOCUMENT_NETWORK_TIMEOUT_SECONDS).toBeGreaterThan(
      POINTER_NETWORK_TIMEOUT_SECONDS,
    );
  });
});

describe("the predicates Serwist calls directly", () => {
  it("reads the same shape Serwist passes a matcher", () => {
    // `matcher` receives `RouteMatchCallbackOptions`, of which `RouteContext` is
    // a subset — so these go through with no adapter. If that ever stops being
    // true, `sw.ts` fails to compile rather than silently matching nothing.
    expect(isApiRoute(context("/api/health"))).toBe(true);
    expect(isDocumentRequest(context("/study", { mode: "navigate" }))).toBe(
      true,
    );
    expect(isDocumentRequest(context("/study"))).toBe(false);
  });
});
