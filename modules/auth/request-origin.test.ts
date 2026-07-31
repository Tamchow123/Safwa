import { describe, expect, it } from "vitest";

import {
  assertSameOrigin,
  originHeadersOf,
  type OriginHeaders,
} from "@/modules/auth/request-origin";

const APP = "https://safwa.example";

function headers(partial: Partial<OriginHeaders>): OriginHeaders {
  return { origin: null, secFetchSite: null, ...partial };
}

describe("assertSameOrigin", () => {
  it("accepts a request the app made of itself", () => {
    expect(
      assertSameOrigin(
        headers({ origin: APP, secFetchSite: "same-origin" }),
        APP,
      ),
    ).toEqual({ sameOrigin: true });
  });

  it("refuses an Origin from another site", () => {
    expect(
      assertSameOrigin(headers({ origin: "https://evil.example" }), APP),
    ).toEqual({ sameOrigin: false, reason: "origin-mismatch" });
  });

  it("refuses a cross-site request even when it sends no Origin", () => {
    // The case SameSite=Lax deliberately permits: a top-level GET navigation
    // from another origin carries the session cookie and no Origin header.
    // Sec-Fetch-Site is the only thing that catches it.
    expect(
      assertSameOrigin(headers({ secFetchSite: "cross-site" }), APP),
    ).toEqual({ sameOrigin: false, reason: "cross-site-fetch" });
  });

  it("refuses a cross-site request whose Origin happens to be absent", () => {
    expect(
      assertSameOrigin(
        headers({ origin: null, secFetchSite: "cross-site" }),
        APP,
      ).sameOrigin,
    ).toBe(false);
  });

  it("allows a request carrying neither header, rather than breaking it", () => {
    // Fail-safe direction, asserted so it cannot be flipped casually. Older
    // browsers send no Sec-Fetch-* and omit Origin on same-origin GETs;
    // refusing on absence would break them to stop an attacker who cannot set
    // either header anyway — both are forbidden header names.
    expect(assertSameOrigin(headers({}), APP)).toEqual({ sameOrigin: true });
  });

  it("allows a same-site sibling, which this deployment does not treat as hostile", () => {
    expect(
      assertSameOrigin(headers({ secFetchSite: "same-site" }), APP).sameOrigin,
    ).toBe(true);
  });

  it("allows a user-initiated navigation (Sec-Fetch-Site: none)", () => {
    // Typing the URL or following a bookmark. Not an attack.
    expect(
      assertSameOrigin(headers({ secFetchSite: "none" }), APP).sameOrigin,
    ).toBe(true);
  });

  it("distinguishes port and scheme, which are part of an origin", () => {
    expect(
      assertSameOrigin(headers({ origin: "http://safwa.example" }), APP)
        .sameOrigin,
      "http is not https",
    ).toBe(false);
    expect(
      assertSameOrigin(headers({ origin: "https://safwa.example:8443" }), APP)
        .sameOrigin,
      "a different port is a different origin",
    ).toBe(false);
  });

  it("refuses a subdomain that merely looks like the app origin", () => {
    expect(
      assertSameOrigin(
        headers({ origin: "https://safwa.example.evil.test" }),
        APP,
      ).sameOrigin,
    ).toBe(false);
  });
});

describe("originHeadersOf", () => {
  it("reads both headers case-insensitively, as the Headers API does", () => {
    const request = new Request("https://safwa.example/api/sync/pull", {
      headers: { Origin: APP, "Sec-Fetch-Site": "same-origin" },
    });
    expect(originHeadersOf(request)).toEqual({
      origin: APP,
      secFetchSite: "same-origin",
    });
  });

  it("reports absent headers as null rather than undefined", () => {
    const request = new Request("https://safwa.example/api/sync/pull");
    expect(originHeadersOf(request)).toEqual({
      origin: null,
      secFetchSite: null,
    });
  });
});
