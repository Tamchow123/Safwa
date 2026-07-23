import { describe, expect, it } from "vitest";

import { NonCanonicalPayloadError, payloadHash } from "./idempotency";

describe("payloadHash", () => {
  it("is stable for the same payload", () => {
    const p = { a: 1, b: "x", c: true };
    expect(payloadHash(p)).toBe(payloadHash(p));
  });

  it("is independent of object key order", () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it("is independent of nested key order", () => {
    expect(payloadHash({ x: { a: 1, b: 2 }, y: [1, 2] })).toBe(
      payloadHash({ y: [1, 2], x: { b: 2, a: 1 } }),
    );
  });

  it("differs when a value differs", () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(payloadHash({ v: [1, 2] })).not.toBe(payloadHash({ v: [2, 1] }));
  });

  it("distinguishes a null from a missing key", () => {
    expect(payloadHash({ a: null })).not.toBe(payloadHash({}));
  });

  it("produces a 64-char hex sha256 digest", () => {
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  // Fail-loud on non-JSON-safe values that would otherwise silently collide.
  it("throws on an explicit-undefined value (would collide with an omitted key)", () => {
    expect(() => payloadHash({ a: undefined })).toThrow(
      NonCanonicalPayloadError,
    );
  });

  it("throws on undefined inside an array (JSON.stringify would coerce to null)", () => {
    expect(() => payloadHash({ a: [1, undefined, 3] })).toThrow(
      NonCanonicalPayloadError,
    );
  });

  it("throws on a Date (would collapse to {} — every Date collides)", () => {
    expect(() => payloadHash({ d: new Date("2024-01-01") })).toThrow(
      NonCanonicalPayloadError,
    );
  });

  it("throws on a non-finite number (NaN/Infinity serialise to null)", () => {
    expect(() => payloadHash({ a: Number.NaN })).toThrow(
      NonCanonicalPayloadError,
    );
    expect(() => payloadHash({ a: Number.POSITIVE_INFINITY })).toThrow(
      NonCanonicalPayloadError,
    );
  });

  it("throws on a bigint value", () => {
    expect(() => payloadHash({ a: BigInt(1) })).toThrow(
      NonCanonicalPayloadError,
    );
  });

  it("hashes a realistic wire-derived payload (nested plain objects/arrays)", () => {
    const payload = {
      eventId: "0192f9a0-1111-7abc-8def-0123456789ab",
      rating: "good",
      parentEventId: null,
      clientComponentRevision: 2,
      selectedAnswerRef: { entryId: 5, field: "meaning" },
      allowed: [1, 2, 3],
    };
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});
