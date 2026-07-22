/**
 * Phase 16 — audit-metadata redaction policy (§17, discharges SEC-001-T3).
 *
 * PURE (no `server-only`, no DB, no clock): the allow-list + per-key value
 * validation that `writeSyncAudit` applies to `sync_audit_log.metadata`. Kept
 * as its own pure module so the security-critical redaction can be verified in
 * the fast unit tier (see audit-metadata.test.ts) and reused by the DB sink.
 *
 * The guarantee is STRUCTURAL, not by caller convention: a value is kept only
 * if its key is on the allow-list AND the value matches that key's expected
 * shape (a UUID, a known enum member, a bounded safe identifier, a boolean, or
 * a finite integer). Anything else — an unknown key, a nested object/array, a
 * bigint/function/undefined, a non-finite number, or a string that does not
 * match its key's shape (e.g. `status: "Bearer …"`) — is DROPPED. So a caller
 * mistake (an error message, a token fragment, a cookie) can never be persisted
 * even under an allow-listed key. Dropping (not throwing) keeps the audit sink
 * from ever aborting the request path it observes.
 */
import { SCHEDULER_RATINGS } from "@/modules/scheduler/fsrs";
import { REVIEW_EVENT_STATUSES } from "@/modules/scheduler/events";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A short lowercase identifier (field names, reasons) — never a token/path/message. */
const SAFE_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,63}$/;

type AuditFieldRule =
  | { kind: "uuid" }
  | { kind: "enum"; values: ReadonlySet<string> }
  | { kind: "identifier" }
  | { kind: "boolean" }
  | { kind: "integer" };

/**
 * The ONLY keys allowed into `sync_audit_log.metadata`, each pinned to the
 * shape its value must match. Adding a key is a deliberate act reviewed against
 * the no-secrets rule (§17); the shape rule is what makes the guarantee hold
 * independently of the caller.
 */
// A `Map` (not a plain object) so a lookup of a prototype-chain name like
// `__proto__`/`constructor`/`toString` — which a `JSON.parse`d body CAN carry
// as a real own key — returns `undefined` and is dropped by construction,
// rather than resolving to an inherited value a bracket-index lookup surfaces.
const AUDIT_METADATA_FIELD_RULES = new Map<string, AuditFieldRule>([
  ["eventId", { kind: "uuid" }],
  ["attemptId", { kind: "uuid" }],
  ["revocationId", { kind: "uuid" }],
  ["parentEventId", { kind: "uuid" }],
  ["status", { kind: "enum", values: new Set(REVIEW_EVENT_STATUSES) }],
  ["claimedRating", { kind: "enum", values: new Set(SCHEDULER_RATINGS) }],
  ["canonicalRating", { kind: "enum", values: new Set(SCHEDULER_RATINGS) }],
  ["claimedIsCorrect", { kind: "boolean" }],
  ["canonicalIsCorrect", { kind: "boolean" }],
  ["expectedRevision", { kind: "integer" }],
  ["actualRevision", { kind: "integer" }],
  ["field", { kind: "identifier" }],
]);

/** The allow-listed metadata keys (derived from the rules — cannot drift). */
export const AUDIT_METADATA_ALLOWED_KEYS: ReadonlySet<string> = new Set(
  AUDIT_METADATA_FIELD_RULES.keys(),
);

/** Max serialized byte size of the whole metadata object (a hard row bound). */
export const AUDIT_METADATA_MAX_BYTES = 1024;

/** Whether a value matches its key's expected shape. */
function matchesRule(rule: AuditFieldRule, value: unknown): boolean {
  switch (rule.kind) {
    case "uuid":
      return typeof value === "string" && UUID_RE.test(value);
    case "enum":
      return typeof value === "string" && rule.values.has(value);
    case "identifier":
      return typeof value === "string" && SAFE_IDENTIFIER_RE.test(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
  }
}

/**
 * Reduce caller-supplied metadata to a safe object: allow-listed keys whose
 * value matches the key's shape rule, capped in total serialized size by
 * dropping keys (sorted) until it fits. Returns `null` when nothing safe
 * remains. PURE — exported for direct unit testing of the redaction policy.
 */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    // Map.get returns undefined for any non-allow-listed key — including a
    // prototype-chain name (`__proto__`/`constructor`) that JSON.parse can carry
    // as a real own key — so such keys are dropped structurally, not by luck.
    const rule = AUDIT_METADATA_FIELD_RULES.get(key);
    if (!rule) continue;
    const value = metadata[key];
    if (matchesRule(rule, value)) safe[key] = value;
    // Anything that fails its shape rule is dropped — this is what closes the
    // "secret smuggled under an allow-listed string key" leak.
  }
  // Defence in depth: even though every kept value is individually bounded by
  // its shape, cap the total serialized size by dropping keys (sorted) until it
  // fits, so the stored row can never exceed the bound.
  const keys = Object.keys(safe).sort();
  while (
    keys.length > 0 &&
    Buffer.byteLength(JSON.stringify(safe), "utf8") > AUDIT_METADATA_MAX_BYTES
  ) {
    const dropped = keys.pop();
    if (dropped !== undefined) delete safe[dropped];
  }
  return Object.keys(safe).length > 0 ? safe : null;
}
