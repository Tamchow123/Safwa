/**
 * Phase 16 — server-side sync audit log (§17). A bounded, SAFE trail of
 * ingestion anomalies and rejections. Records only structured, redacted
 * diagnostic fields — NEVER passwords, tokens, cookies, full request bodies,
 * learner answer content, raw database errors or assessment-manifest contents.
 *
 * `metadata` is a small, structured, redacted object (e.g. a claimed-vs-
 * canonical rating). The caller is responsible for keeping it redacted; a
 * follow-up hardens this with an allow-list + size bound (tracked as debt).
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

import type { SyncTx } from "./cursor";

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
  /** Small, redacted, structured detail only — never raw payloads/secrets. */
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
    metadata: entry.metadata ?? null,
  });
}
