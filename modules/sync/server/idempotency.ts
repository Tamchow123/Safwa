/**
 * Phase 16 — idempotency payload hashing (§8.5). A mutation id (event_id /
 * attempt id) is the idempotency key; re-delivering the SAME id with the SAME
 * immutable payload is a no-op that returns the prior result, while re-using an
 * id with a DIFFERENT immutable payload is a conflict (rejected + audited). We
 * detect the latter by comparing a stable hash of the immutable fields.
 *
 * PURE: deterministic canonical-JSON hashing, no clock/randomness/DB.
 */
import { createHash } from "node:crypto";

/** Thrown when a payload contains a value that is not JSON-safe (see below). */
export class NonCanonicalPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonCanonicalPayloadError";
  }
}

/**
 * Canonicalise a JSON-safe value: object keys sorted recursively (so key order
 * doesn't change the hash) with array order preserved.
 *
 * FAIL-LOUD on anything that JSON serialisation would silently collapse into a
 * false collision — because this hash is an INTEGRITY mechanism (same id +
 * "same" payload → idempotent no-op; different payload → conflict). Rejected:
 *   - `undefined` (JSON.stringify drops it → collides with an omitted key);
 *   - non-finite numbers NaN/Infinity (serialise to `null`);
 *   - non-plain objects — Date/Map/Set/class instances (e.g. `Object.keys(Date)`
 *     is `[]`, collapsing every Date to `{}`);
 *   - bigint / function / symbol.
 * The caller only ever passes validated, JSON-safe wire-derived fields
 * (string/number/boolean/null and nested plain objects/arrays), so this never
 * throws in practice — it is a defensive backstop, not a normal path.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new NonCanonicalPayloadError(
        "payload contains a non-finite number (NaN/Infinity)",
      );
    }
    return value;
  }
  if (type !== "object") {
    // undefined, bigint, function, symbol
    throw new NonCanonicalPayloadError(
      `payload contains an unsupported ${type} value`,
    );
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new NonCanonicalPayloadError(
      "payload contains a non-plain object (Date/Map/Set/class instance)",
    );
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    // A key whose value is `undefined` throws in the recursive call above,
    // so an explicit-undefined field can never collide with an omitted one.
    sorted[key] = canonicalize(record[key]);
  }
  return sorted;
}

/**
 * Stable SHA-256 (hex) of a mutation's immutable payload fields. Throws
 * `NonCanonicalPayloadError` on any non-JSON-safe value (see `canonicalize`).
 */
export function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}
