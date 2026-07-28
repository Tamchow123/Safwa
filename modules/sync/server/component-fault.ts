/**
 * Phase 17 (REL-006) — classification of a failure caught at a
 * COMPONENT-ISOLATION boundary.
 *
 * `ingest`, `revoke` and `pull` each process one component at a time and
 * isolate a failure so the other components still succeed. Until now every such
 * failure was reported as `internal_error`, which `RECOVERABLE_REASON_CODES`
 * marks retryable — correct for a transient database fault, actively harmful
 * for a `ChainError`, which says the component's ALREADY-STORED event set is
 * structurally impossible. Nothing the client resubmits changes stored rows, so
 * a retryable classification makes the client retry a permanent condition
 * forever and hides it from whoever could actually fix it.
 *
 * Phase 17 made this far likelier: a merge union is a legitimately multi-rooted
 * component, so an UNMARKED multi-rooted component is now a shape the system
 * can produce, not near-impossible corruption.
 *
 * PURE (no `server-only`, no DB, no clock) — one branch on the error type, so
 * it is unit-testable without a database, exactly like `audit-metadata`.
 */
import { ChainError } from "@/modules/scheduler";
import type { SyncReasonCode } from "@/modules/sync/protocol";

/**
 * The reason code to report for `error` at a component-isolation boundary:
 * the PERMANENT `component_integrity_error` for a replay/lineage
 * `ChainError`, and the recoverable `internal_error` for everything else
 * (a dropped connection, a lock timeout, an unexpected bug).
 */
export function componentFaultReason(error: unknown): SyncReasonCode {
  return error instanceof ChainError
    ? "component_integrity_error"
    : "internal_error";
}
