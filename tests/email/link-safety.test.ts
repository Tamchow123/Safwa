import { describe, expect, it } from "vitest";
import {
  assertSameOrigin,
  UnsafeEmailLinkError,
} from "@/modules/email/link-safety";

describe("assertSameOrigin", () => {
  const CANONICAL = "https://safwa.example.com";

  it("accepts a URL matching the canonical origin, any path/query", () => {
    expect(() =>
      assertSameOrigin(`${CANONICAL}/verify-email?token=abc123`, CANONICAL),
    ).not.toThrow();
  });

  it("rejects a URL on a different host", () => {
    expect(() =>
      assertSameOrigin("https://evil.example.com/verify-email", CANONICAL),
    ).toThrow(UnsafeEmailLinkError);
  });

  it("rejects a URL on a different scheme", () => {
    expect(() =>
      assertSameOrigin("http://safwa.example.com/verify-email", CANONICAL),
    ).toThrow(UnsafeEmailLinkError);
  });

  it("rejects a URL on a different port", () => {
    expect(() =>
      assertSameOrigin(
        "https://safwa.example.com:8443/verify-email",
        CANONICAL,
      ),
    ).toThrow(UnsafeEmailLinkError);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertSameOrigin("not a url", CANONICAL)).toThrow(
      UnsafeEmailLinkError,
    );
  });

  it("never includes a live token's query string in the thrown error message", () => {
    const urlWithToken =
      "not-a-valid-url-but-has?token=live-secret-token-12345";
    try {
      assertSameOrigin(urlWithToken, CANONICAL);
      throw new Error("expected assertSameOrigin to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeEmailLinkError);
      expect((error as Error).message).not.toContain("live-secret-token-12345");
    }
  });

  it("origin-mismatch errors never include the mismatched URL's query string either", () => {
    const urlWithToken =
      "https://evil.example.com/verify-email?token=live-secret-token-99999";
    try {
      assertSameOrigin(urlWithToken, CANONICAL);
      throw new Error("expected assertSameOrigin to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeEmailLinkError);
      expect((error as Error).message).not.toContain("live-secret-token-99999");
    }
  });
});
