/**
 * Phase 16 — idempotency payload hashing (§8.5). A mutation id (event_id /
 * attempt id) is the idempotency key; re-delivering the SAME id with the SAME
 * immutable payload is a no-op that returns the prior result, while re-using an
 * id with a DIFFERENT immutable payload is a conflict (rejected + audited). We
 * detect the latter by comparing a stable hash of the immutable fields.
 *
 * The canonicalisation rules themselves live in the isomorphic protocol module
 * (`modules/sync/protocol/canonical-json.ts`): the Phase-17 guest merge hashes
 * its snapshot in the BROWSER and the server compares that hash here
 * (phases-17.md §12, §15), so both sides must agree byte-for-byte on what "the
 * same payload" means. A second copy of the rules could drift by one case and
 * turn a legitimate retry into a spurious payload conflict — or let two
 * genuinely different payloads hash alike.
 *
 * PURE: deterministic canonical-JSON hashing, no clock/randomness/DB.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "@/modules/sync/protocol";

export { NonCanonicalPayloadError } from "@/modules/sync/protocol";

/**
 * Stable SHA-256 (hex) of a mutation's immutable payload fields. Throws
 * `NonCanonicalPayloadError` on any non-JSON-safe value (see `canonicalize`).
 */
export function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
