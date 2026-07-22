import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFE_REDIRECT,
  resolveSafeRedirect,
} from "@/modules/auth/redirects";

describe("resolveSafeRedirect", () => {
  it("allows a same-origin relative path", () => {
    expect(resolveSafeRedirect("/dashboard")).toBe("/dashboard");
  });

  it("allows a same-origin relative path with query and hash", () => {
    expect(resolveSafeRedirect("/library?tab=saved#top")).toBe(
      "/library?tab=saved#top",
    );
  });

  it("defaults to / for null, undefined, or empty", () => {
    expect(resolveSafeRedirect(null)).toBe(DEFAULT_SAFE_REDIRECT);
    expect(resolveSafeRedirect(undefined)).toBe(DEFAULT_SAFE_REDIRECT);
    expect(resolveSafeRedirect("")).toBe(DEFAULT_SAFE_REDIRECT);
  });

  it("rejects an external origin", () => {
    expect(resolveSafeRedirect("https://evil.example.com/phish")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
    expect(resolveSafeRedirect("http://evil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("rejects a protocol-relative URL", () => {
    expect(resolveSafeRedirect("//evil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
    expect(resolveSafeRedirect("///evil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("rejects a javascript: URL", () => {
    expect(resolveSafeRedirect("javascript:alert(1)")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("rejects a data: URL", () => {
    expect(
      resolveSafeRedirect("data:text/html,<script>alert(1)</script>"),
    ).toBe(DEFAULT_SAFE_REDIRECT);
  });

  it("rejects an encoded open redirect", () => {
    // Decodes to "//evil.example.com" — protocol-relative once unescaped.
    expect(resolveSafeRedirect("/%2F%2Fevil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
    // Decodes to a backslash variant.
    expect(resolveSafeRedirect("/%5Cevil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("rejects a backslash variant", () => {
    expect(resolveSafeRedirect("/\\evil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
    expect(resolveSafeRedirect("\\\\evil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("rejects an excessively long value", () => {
    const tooLong = `/${"a".repeat(600)}`;
    expect(resolveSafeRedirect(tooLong)).toBe(DEFAULT_SAFE_REDIRECT);
  });

  it("rejects a value that does not start with a single slash", () => {
    expect(resolveSafeRedirect("dashboard")).toBe(DEFAULT_SAFE_REDIRECT);
    expect(resolveSafeRedirect("evil.example.com/dashboard")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("rejects a malformed percent-encoding sequence", () => {
    expect(resolveSafeRedirect("/%")).toBe(DEFAULT_SAFE_REDIRECT);
  });

  it("rejects a doubly percent-encoded open redirect", () => {
    // Decodes once to the still-encoded "/%2F%2Fevil.example.com", and
    // only reveals "//evil.example.com" on a SECOND decode — a naive
    // single-decode check would see it as safe.
    expect(resolveSafeRedirect("/%252F%252Fevil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("rejects an encoded-tab bypass of the protocol-relative check", () => {
    expect(resolveSafeRedirect("/%09/evil.example.com")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });

  it("accepts a leading slash before a scheme-like string as an inert path segment", () => {
    // Never a URL scheme once prefixed with "/" — every URL/navigation
    // context parses this as a literal relative path, not javascript:.
    expect(resolveSafeRedirect("/JavaScript:alert(1)")).toBe(
      "/JavaScript:alert(1)",
    );
  });

  it("accepts a value at exactly the maximum length and rejects one byte over", () => {
    const atLimit = `/${"a".repeat(511)}`;
    const overLimit = `/${"a".repeat(512)}`;
    expect(atLimit).toHaveLength(512);
    expect(resolveSafeRedirect(atLimit)).toBe(atLimit);
    expect(resolveSafeRedirect(overLimit)).toBe(DEFAULT_SAFE_REDIRECT);
  });
});
