/**
 * Canonical JSON serialisation for INTEGRITY hashing — the one definition
 * shared by the server's per-mutation idempotency hash
 * (`modules/sync/server/idempotency.ts`) and the client's guest-snapshot hash
 * (`modules/sync/client/guest-snapshot.ts`).
 *
 * It has to be shared rather than duplicated: the guest merge (phases-17.md
 * §12, §15) resubmits one import key against a snapshot hash the SERVER
 * compares, so the two sides must agree byte-for-byte on what "the same
 * payload" means. Two independent canonicalisers that drift by one rule turn a
 * legitimate retry into a spurious payload conflict, or — far worse — let two
 * genuinely different payloads hash alike.
 *
 * PURE and isomorphic: no crypto, no clock, no randomness, no Node built-ins,
 * so the browser and the server can both import it. The digest itself is taken
 * by the caller with whatever primitive its runtime has (`node:crypto` on the
 * server, Web Crypto in the browser).
 */

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
 * Callers only ever pass validated, JSON-safe wire-derived fields
 * (string/number/boolean/null and nested plain objects/arrays), so this never
 * throws in practice — it is a defensive backstop, not a normal path.
 */
export function canonicalize(value: unknown): unknown {
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
 * The exact string whose UTF-8 bytes are hashed. Callers must digest THIS —
 * never `JSON.stringify(value)` directly — or the two sides of a hash
 * comparison stop agreeing.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
