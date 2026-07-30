import { describe, expect, it } from "vitest";

import {
  isGoodResponse,
  isPrivateResponse,
  isStorableResponse,
  SERVER_RENDERED_CACHE_MAX_AGE_SECONDS,
} from "@/modules/pwa/cache-policy";

/**
 * What may be written to the two server-rendered caches.
 *
 * Separate from `cache-rules.test.ts` because it is a separate question: those
 * tests resolve a REQUEST to a rule, these admit or refuse a RESPONSE once a
 * rule has been chosen. This is where the module's confidentiality guarantee is
 * asserted, so the two halves of `isStorableResponse` are exercised
 * independently as well as composed — each is there for its own reason and
 * either could be weakened without the other's tests noticing.
 */
const withCacheControl = (value?: string): Response =>
  new Response("<html>", {
    headers: value === undefined ? {} : { "cache-control": value },
  });

describe("whether a response is worth caching at all", () => {
  it("admits a 200 and refuses every other status", () => {
    // NOT belt-and-braces. `NetworkFirst` prepends its own status guard only
    // `if (!this.plugins.some((p) => "cacheWillUpdate" in p))` — so registering
    // the privacy guard is precisely what removes it, and this check is what
    // puts it back. A cached 500 is worse than no cache: `Strategy` treats only
    // `undefined` or `type === "error"` as a failure, so a same-origin 500 is
    // replayed as though it were the page and `/~offline` never fires.
    expect(isGoodResponse(new Response("ok", { status: 200 }))).toBe(true);
    for (const status of [500, 404, 302, 401, 503]) {
      expect(
        isGoodResponse(new Response("nope", { status })),
        `status ${status}`,
      ).toBe(false);
    }
  });

  it("admits status 0, matching the upstream plugin exactly", () => {
    // `status === 0` covers both opaque and error responses, and this admits
    // both — as serwist's own `cacheOkAndOpaquePlugin` does. Every rule here is
    // same-origin guarded so an opaque response cannot arrive, and an error
    // response cannot either: `Strategy._getResponse` throws on
    // `response.type === "error"` BEFORE any `cacheWillUpdate` runs. Mirroring
    // upstream rather than narrowing it keeps this from diverging silently from
    // the library the day one of those facts changes.
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "status", { value: 0 });
    expect(isGoodResponse(opaque)).toBe(true);
    expect(Response.error().status).toBe(0);
  });
});

describe("whether the server marked a response private", () => {
  it("recognises exactly what Next marks on a dynamically rendered route", () => {
    // Measured against `pnpm start` on this build: /study/weak and /account
    // answer with this header, and /account server-renders the learner's name
    // and email. Nothing else keeps that out of a shared device's cache.
    expect(
      isPrivateResponse(
        withCacheControl(
          "private, no-cache, no-store, max-age=0, must-revalidate",
        ),
      ),
    ).toBe(true);
  });

  it("does not flag what Next marks on a prerendered route", () => {
    // The other half, measured the same way: /study answers this, and it is the
    // same bytes for every visitor.
    expect(isPrivateResponse(withCacheControl("s-maxage=31536000"))).toBe(
      false,
    );
  });

  it("flags either directive on its own, in any case", () => {
    expect(isPrivateResponse(withCacheControl("no-store"))).toBe(true);
    expect(isPrivateResponse(withCacheControl("private"))).toBe(true);
    expect(isPrivateResponse(withCacheControl("PRIVATE, NO-STORE"))).toBe(true);
  });

  it("treats a missing header as no claim rather than as private", () => {
    // Deliberate, and the reasoning is recorded at the function: requiring a
    // positive marker instead would silently stop caching every document if a
    // hosting edge normalised the marker away, taking offline study with it.
    expect(isPrivateResponse(withCacheControl())).toBe(false);
    expect(isPrivateResponse(withCacheControl("max-age=0"))).toBe(false);
  });
});

describe("the two composed, as `sw.ts` wires them", () => {
  it("refuses a private response even though its status is fine", () => {
    const response = withCacheControl(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(isGoodResponse(response)).toBe(true);
    expect(isStorableResponse(response)).toBe(false);
  });

  it("refuses a non-200 even though it claims nothing about privacy", () => {
    const response = new Response("nope", { status: 500 });
    expect(isPrivateResponse(response)).toBe(false);
    expect(isStorableResponse(response)).toBe(false);
  });

  it("stores a public 200, which is the whole point", () => {
    // Refusing this would cost offline study the app shell to protect nothing.
    expect(isStorableResponse(withCacheControl("s-maxage=31536000"))).toBe(
      true,
    );
    expect(isStorableResponse(withCacheControl())).toBe(true);
  });
});

describe("the age bound on the two server-rendered caches", () => {
  it("bounds them in time as well as in count", () => {
    // The count bound never evicts anything in an app with under 20 routes, so
    // without this an entry that slipped past `isStorableResponse` would live
    // forever. `ExpirationPlugin` enforces maxAge on READ too, so a stale entry
    // is not served even offline.
    expect(SERVER_RENDERED_CACHE_MAX_AGE_SECONDS).toBeGreaterThan(0);
  });

  it("keeps the bound long enough not to break offline study", () => {
    // A backstop, not the mechanism. Anything short enough to matter to the
    // exposure window would also cost a learner their cached pages on an
    // ordinary trip away from a connection — and the clock is stamped at write
    // time, not refreshed by reads, so the bound is measured from the last
    // successful fetch rather than from the last visit.
    const days = SERVER_RENDERED_CACHE_MAX_AGE_SECONDS / (24 * 60 * 60);
    expect(days).toBeGreaterThanOrEqual(14);
    expect(days).toBeLessThanOrEqual(90);
  });
});
