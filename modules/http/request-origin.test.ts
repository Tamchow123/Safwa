import { describe, expect, it } from "vitest";

import {
  originHeadersOf,
  requestOriginOf,
  verifySameOrigin,
  type OriginHeaders,
} from "@/modules/http/request-origin";

const APP = "https://safwa.example";

function headers(partial: Partial<OriginHeaders>): OriginHeaders {
  return { origin: null, secFetchSite: null, requestOrigin: null, ...partial };
}

describe("verifySameOrigin", () => {
  it("accepts a request the app made of itself", () => {
    expect(
      verifySameOrigin(
        headers({ origin: APP, secFetchSite: "same-origin" }),
        APP,
      ),
    ).toEqual({ sameOrigin: true });
  });

  it("refuses an Origin from another site", () => {
    expect(
      verifySameOrigin(headers({ origin: "https://evil.example" }), APP),
    ).toEqual({ sameOrigin: false, reason: "origin-mismatch" });
  });

  it("refuses a cross-site request even when it sends no Origin", () => {
    // The case SameSite=Lax deliberately permits: a top-level GET navigation
    // from another origin carries the session cookie and no Origin header.
    // Sec-Fetch-Site is the only thing that catches it.
    expect(
      verifySameOrigin(headers({ secFetchSite: "cross-site" }), APP),
    ).toEqual({ sameOrigin: false, reason: "cross-site-fetch" });
  });

  it("allows a request carrying neither header, rather than breaking it", () => {
    // Fail-safe direction, asserted so it cannot be flipped casually. Older
    // browsers send no Sec-Fetch-* and omit Origin on same-origin GETs;
    // refusing on absence would break them to stop an attacker who cannot set
    // either header anyway — both are forbidden header names.
    expect(verifySameOrigin(headers({}), APP)).toEqual({ sameOrigin: true });
  });

  it("allows a same-site sibling, which this deployment does not treat as hostile", () => {
    expect(
      verifySameOrigin(headers({ secFetchSite: "same-site" }), APP).sameOrigin,
    ).toBe(true);
  });

  it("allows a user-initiated navigation (Sec-Fetch-Site: none)", () => {
    expect(
      verifySameOrigin(headers({ secFetchSite: "none" }), APP).sameOrigin,
    ).toBe(true);
  });

  it("distinguishes port and scheme, which are part of an origin", () => {
    expect(
      verifySameOrigin(headers({ origin: "http://safwa.example" }), APP)
        .sameOrigin,
      "http is not https",
    ).toBe(false);
    expect(
      verifySameOrigin(headers({ origin: "https://safwa.example:8443" }), APP)
        .sameOrigin,
      "a different port is a different origin",
    ).toBe(false);
  });

  it("refuses a subdomain that merely looks like the app origin", () => {
    expect(
      verifySameOrigin(
        headers({ origin: "https://safwa.example.evil.test" }),
        APP,
      ).sameOrigin,
    ).toBe(false);
  });

  describe("the origin the request was addressed to", () => {
    const preview = "https://safwa-git-feature-x.vercel.app";

    it("accepts a host the app was reached on but is not configured as", () => {
      // THE PREVIEW-DEPLOYMENT CASE, and the reason this branch exists at all.
      // A platform that mints a hostname per deployment (a Vercel preview)
      // serves the app on a host NEXT_PUBLIC_APP_URL does not name. Comparing
      // against configuration alone refused every authenticated request with
      // 403 — sync and settings entirely broken on every preview, presenting
      // as an auth bug rather than a configuration one.
      expect(
        verifySameOrigin(
          headers({ origin: preview, requestOrigin: preview }),
          APP,
        ),
      ).toEqual({ sameOrigin: true });
    });

    it("still refuses a foreign Origin on that same preview host", () => {
      // The request's own host is an ADDITIONAL same-origin candidate, not a
      // bypass. Without this, the fix for the preview case would have been a
      // hole.
      expect(
        verifySameOrigin(
          headers({ origin: "https://evil.example", requestOrigin: preview }),
          APP,
        ).sameOrigin,
      ).toBe(false);
    });

    it("still refuses a cross-site navigation to the preview host", () => {
      expect(
        verifySameOrigin(
          headers({ secFetchSite: "cross-site", requestOrigin: preview }),
          APP,
        ).sameOrigin,
      ).toBe(false);
    });
  });
});

describe("requestOriginOf", () => {
  it("prefers the forwarded host and proto a platform proxy sets", () => {
    // On Vercel the function sees an internal http:// URL while the browser
    // used https://. Reading the URL alone would mismatch on scheme.
    const request = new Request("http://internal.local/api/sync/pull", {
      headers: {
        "x-forwarded-host": "safwa.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(requestOriginOf(request)).toBe("https://safwa.example");
  });

  it("takes the first hop when the proto chain has several", () => {
    const request = new Request("http://internal.local/api/sync/pull", {
      headers: {
        "x-forwarded-host": "safwa.example",
        "x-forwarded-proto": "https, http",
      },
    });
    expect(requestOriginOf(request)).toBe("https://safwa.example");
  });

  it("falls back to Host and the URL's own scheme", () => {
    const request = new Request("http://localhost:3000/api/sync/pull", {
      headers: { host: "localhost:3000" },
    });
    expect(requestOriginOf(request)).toBe("http://localhost:3000");
  });

  it("reports no evidence rather than guessing when the host is unusable", () => {
    // Returning null must mean "no additional candidate", never "allow" — the
    // configured origin is still checked and a mismatching Origin still fails.
    const request = new Request("http://localhost/api/sync/pull", {
      headers: { host: "a host with spaces" },
    });
    const derived = requestOriginOf(request);
    expect(derived).toBeNull();
    expect(
      verifySameOrigin(
        headers({ origin: "https://evil.example", requestOrigin: derived }),
        APP,
      ).sameOrigin,
    ).toBe(false);
  });
});

describe("originHeadersOf", () => {
  it("reads every header case-insensitively, as the Headers API does", () => {
    const request = new Request("https://safwa.example/api/sync/pull", {
      headers: {
        Origin: APP,
        "Sec-Fetch-Site": "same-origin",
        Host: "safwa.example",
      },
    });
    expect(originHeadersOf(request)).toEqual({
      origin: APP,
      secFetchSite: "same-origin",
      requestOrigin: APP,
    });
  });

  it("reports absent headers as null rather than undefined", () => {
    const request = new Request("https://safwa.example/api/sync/pull");
    expect(originHeadersOf(request)).toMatchObject({
      origin: null,
      secFetchSite: null,
    });
  });
});
