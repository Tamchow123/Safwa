import { describe, expect, it } from "vitest";

import { canonicalJson, NonCanonicalPayloadError } from "./canonical-json";

describe("canonicalJson", () => {
  it("is insensitive to object key order at every depth", () => {
    const a = { b: 1, a: { d: [{ y: 2, x: 1 }], c: true } };
    const b = { a: { c: true, d: [{ x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("PRESERVES array order — a reordered list is different data", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes values JSON would collapse together", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({ a: 0 }));
    expect(canonicalJson({ a: [] })).not.toBe(canonicalJson({ a: {} }));
  });

  it("rejects an explicit undefined rather than colliding with an omitted key", () => {
    // JSON.stringify drops it, so `{a:1, b:undefined}` and `{a:1}` would hash
    // alike — exactly the false idempotency this guards against.
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(
      NonCanonicalPayloadError,
    );
  });

  it("rejects non-finite numbers, non-plain objects and bigint", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(
      NonCanonicalPayloadError,
    );
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(
      NonCanonicalPayloadError,
    );
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(
      NonCanonicalPayloadError,
    );
    expect(() => canonicalJson({ a: new Map() })).toThrow(
      NonCanonicalPayloadError,
    );
    // BigInt built rather than written as a `1n` literal (the tsconfig target
    // predates BigInt literals; the runtime value is what matters here).
    expect(() => canonicalJson({ a: BigInt(1) })).toThrow(
      NonCanonicalPayloadError,
    );
  });

  it("accepts a null-prototype object (a plain bag of data)", () => {
    const bag = Object.assign(Object.create(null) as object, { a: 1 });
    expect(canonicalJson(bag)).toBe('{"a":1}');
  });
});
