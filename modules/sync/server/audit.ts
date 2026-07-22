/**
 * Phase 16 — server-side sync audit log (§17). A bounded, SAFE trail of
 * ingestion anomalies and rejections. Records only structured, redacted
 * diagnostic fields — NEVER passwords, tokens, cookies, full request bodies,
 * learner answer content, raw database errors or assessment-manifest contents.
 *
 * `metadata` is HARDENED at the sink (not merely by caller convention): every
 * entry is passed through `sanitizeAuditMetadata` (the pure allow-list + per-key
 * shape-validation policy in ./audit-metadata), so a key not on the allow-list,
 * a value that does not match its key's expected shape (id/enum/identifier/
 * boolean/integer), a nested object/array, or an over-cap blob is DROPPED — a
 * caller mistake can never persist a secret, a raw payload, or an unbounded
 * blob. See ./audit-metadata for the full policy + fast unit tests.
 *
 * `server-only` — writes through a live Drizzle connection/transaction.
 */
import "server-only";

import type { Database } from "@/db/client";
import { syncAuditLog } from "@/db/schema";
import type {
  SyncAuditSeverity,
  SyncItemKind,
  SyncReasonCode,
} from "@/modules/sync/protocol";

import { sanitizeAuditMetadata } from "./audit-metadata";
import type { SyncTx } from "./cursor";

export {
  AUDIT_METADATA_ALLOWED_KEYS,
  AUDIT_METADATA_MAX_BYTES,
  sanitizeAuditMetadata,
} from "./audit-metadata";

export type SyncAuditEntry = {
  userId: string;
  itemKind: SyncItemKind;
  itemId: string;
  reasonCode: SyncReasonCode;
  severity: SyncAuditSeverity;
  releaseId?: string | null;
  componentKey?: string | null;
  correlationId?: string | null;
  clockSuspect?: boolean;
  timezoneCorrected?: boolean;
  /** Small, redacted diagnostic detail — sanitised at the sink (see above). */
  metadata?: Record<string, unknown> | null;
};

/** Append one audit entry. Runs inside the ingestion transaction when given a tx. */
export async function writeSyncAudit(
  db: Database | SyncTx,
  entry: SyncAuditEntry,
): Promise<void> {
  await db.insert(syncAuditLog).values({
    userId: entry.userId,
    itemKind: entry.itemKind,
    itemId: entry.itemId,
    reasonCode: entry.reasonCode,
    severity: entry.severity,
    releaseId: entry.releaseId ?? null,
    componentKey: entry.componentKey ?? null,
    correlationId: entry.correlationId ?? null,
    clockSuspect: entry.clockSuspect ?? false,
    timezoneCorrected: entry.timezoneCorrected ?? false,
    // Harden at the sink: strip to allow-listed, primitive, bounded fields so a
    // caller mistake can never persist a secret/payload/unbounded blob.
    metadata: sanitizeAuditMetadata(entry.metadata),
  });
}
