import { describe, expect, it } from "vitest";

import {
  AUDIT_METADATA_ALLOWED_KEYS,
  AUDIT_METADATA_MAX_BYTES,
  sanitizeAuditMetadata,
} from "./audit-metadata";

const UUID = "0192f9a0-1111-7abc-8def-0123456789ab";

describe("sanitizeAuditMetadata (redaction policy)", () => {
  it("returns null for null/undefined/empty", () => {
    expect(sanitizeAuditMetadata(null)).toBeNull();
    expect(sanitizeAuditMetadata(undefined)).toBeNull();
    expect(sanitizeAuditMetadata({})).toBeNull();
  });

  it("keeps allow-listed keys whose values match their shape", () => {
    expect(
      sanitizeAuditMetadata({
        eventId: UUID,
        status: "revoked",
        claimedRating: "good",
        canonicalRating: "again",
        claimedIsCorrect: true,
        canonicalIsCorrect: false,
        expectedRevision: 3,
        actualRevision: 2,
        field: "meaning",
      }),
    ).toEqual({
      eventId: UUID,
      status: "revoked",
      claimedRating: "good",
      canonicalRating: "again",
      claimedIsCorrect: true,
      canonicalIsCorrect: false,
      expectedRevision: 3,
      actualRevision: 2,
      field: "meaning",
    });
  });

  it("drops keys that are not on the allow-list (e.g. secrets)", () => {
    expect(
      sanitizeAuditMetadata({
        eventId: UUID,
        password: "hunter2",
        token: "Bearer abc",
        authorization: "secret",
        selectedAnswerRef: { entryId: 5, field: "meaning" },
      }),
    ).toEqual({ eventId: UUID });
  });

  it("drops nested objects/arrays under an allow-listed key (no payloads)", () => {
    expect(
      sanitizeAuditMetadata({
        field: { smuggled: "payload" } as unknown as string,
        status: [1, 2, 3] as unknown as string,
        eventId: UUID,
      }),
    ).toEqual({ eventId: UUID });
  });

  // The blocking security case (SEC-001): a secret smuggled as a string under an
  // allow-listed key must be DROPPED by shape validation, not truncated-and-kept.
  it("drops a secret-shaped string under an allow-listed string key", () => {
    expect(
      sanitizeAuditMetadata({ status: "Bearer abcdef0123456789" }),
    ).toBeNull();
    expect(sanitizeAuditMetadata({ eventId: "not-a-uuid" })).toBeNull();
    expect(
      sanitizeAuditMetadata({
        canonicalRating: "again; DROP TABLE users",
      }),
    ).toBeNull();
    expect(
      sanitizeAuditMetadata({ field: "Authorization: Bearer x" }),
    ).toBeNull();
  });

  it("drops non-integer / non-finite numbers on integer keys", () => {
    expect(
      sanitizeAuditMetadata({
        actualRevision: Number.NaN,
        expectedRevision: 3,
      }),
    ).toEqual({ expectedRevision: 3 });
    expect(sanitizeAuditMetadata({ actualRevision: 1.5 })).toBeNull();
  });

  it("drops a boolean-keyed value that is not a boolean", () => {
    expect(
      sanitizeAuditMetadata({ claimedIsCorrect: "true" as unknown as boolean }),
    ).toBeNull();
  });

  it("drops prototype-chain own-property names structurally (no pollution)", () => {
    // JSON.parse creates __proto__/constructor as REAL own enumerable keys; the
    // Map-based allow-list returns undefined for them, so they are dropped.
    const evil = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": "x", "toString": "y", "eventId": "' +
        UUID +
        '"}',
    );
    const out = sanitizeAuditMetadata(evil);
    expect(out).toEqual({ eventId: UUID });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops a literal constructor own key", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "constructor", {
      value: "Bearer secret",
      enumerable: true,
    });
    input.eventId = UUID;
    expect(sanitizeAuditMetadata(input)).toEqual({ eventId: UUID });
  });

  it("keeps the full valid metadata set within the total byte bound", () => {
    const out = sanitizeAuditMetadata({
      eventId: UUID,
      attemptId: UUID,
      revocationId: UUID,
      parentEventId: UUID,
      status: "scheduling",
      claimedRating: "good",
      canonicalRating: "again",
      claimedIsCorrect: true,
      canonicalIsCorrect: false,
      expectedRevision: 3,
      actualRevision: 2,
      field: "meaning",
    });
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(
      AUDIT_METADATA_MAX_BYTES,
    );
  });

  it("exposes an allow-list derived from the field rules", () => {
    expect(AUDIT_METADATA_ALLOWED_KEYS.has("eventId")).toBe(true);
    expect(AUDIT_METADATA_ALLOWED_KEYS.has("password")).toBe(false);
  });
});
