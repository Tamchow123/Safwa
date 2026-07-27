/**
 * Phase 16 online-sync wire protocol — shared constants and enumerations.
 *
 * This module is PURE and isomorphic: it is imported by both the browser sync
 * client (`modules/sync/client`) and the authenticated server pipeline
 * (`modules/sync/server`). It must never import React, Dexie, `server-only`,
 * Node built-ins, or the database — only Zod and other pure content modules.
 *
 * The wire mirrors the client's in-memory record types (camelCase). Postgres
 * columns are snake_case and mapped declaratively by Drizzle, so no second
 * hand-written casing translation exists (docs/OFFLINE_AND_SYNC.md, ADR-006).
 */

/**
 * Wire protocol version. Bumped only on a breaking change to the request or
 * response shape; the server rejects an unsupported version with a
 * client-upgrade signal rather than guessing (phases-16.md §9).
 */
export const SYNC_PROTOCOL_VERSION = 1 as const;

/** Kinds of mutation a single push batch may carry. */
export const SYNC_ITEM_KINDS = [
  "attempt",
  "event",
  "revocation",
  "bookmark",
  "list",
  "setting",
] as const;
export type SyncItemKind = (typeof SYNC_ITEM_KINDS)[number];

/**
 * Per-item outcome status. The server returns exactly one result per submitted
 * item; `status` is the coarse classification and `reasonCode` the precise
 * cause (phases-16.md §9.2).
 *
 * - `accepted`   — applied to authoritative state.
 * - `corrected`  — accepted, but a client claim (correctness/rating/time) was
 *                  overridden by the server-derived canonical value.
 * - `duplicate`  — idempotent no-op; the prior canonical result is returned.
 * - `pending`    — held (e.g. unknown parent); recoverable, reprocessed later.
 * - `rejected`   — not applied; see `reasonCode` and `recoverable`.
 */
export const SYNC_ITEM_STATUSES = [
  "accepted",
  "corrected",
  "duplicate",
  "pending",
  "rejected",
] as const;
export type SyncItemStatus = (typeof SYNC_ITEM_STATUSES)[number];

/**
 * Safe, enumerated reason codes. These are the ONLY machine-readable failure
 * signals crossing the wire — never a raw error message, SQL, stack trace or
 * assessment answer (phases-16.md §9.2, §17). The client maps them to honest
 * user-facing copy; the server audit log records them verbatim.
 */
export const SYNC_REASON_CODES = [
  // success / idempotency
  "accepted",
  "duplicate",
  // causal lineage (Stage A)
  "pending_parent",
  "cycle_detected",
  "impossible_lineage",
  "cross_user_parent",
  "cross_component_parent",
  "invalid_revision",
  "stale_branch_conflict",
  // idempotency conflict
  "payload_conflict",
  // content / manifest validation
  "unsupported_generator_version",
  "invalid_release",
  "revoked_release",
  "ineligible_field",
  "natural_key_mismatch",
  "option_not_in_set",
  "question_mismatch",
  "unknown_entry",
  // grading / rating corrections
  "correctness_corrected",
  "rating_corrected",
  "clock_corrected",
  "unsupported_rating",
  // events / revocation
  "not_scheduling_authoritative",
  "revocation_unknown_event",
  "revocation_already_revoked",
  "revocation_has_descendants",
  // collections / settings
  "invalid_list",
  "invalid_setting_key",
  // top-level / availability
  "sync_disabled",
  "malformed_item",
  "internal_error",
  // storage safety (EXT-F4): a component already holds the maximum number of
  // pending-parent events; the client retries once the real parent arrives (so
  // the child accepts directly) or the backlog is purged.
  "pending_quota_exceeded",
] as const;
export type SyncReasonCode = (typeof SYNC_REASON_CODES)[number];

/**
 * Severity of an audit entry. `info` records an accepted-with-correction; the
 * higher levels flag possible tampering or bugs (phases-16.md §17,
 * ARCHITECTURE.md §8 — sync-rejection logs are first-class monitoring signals).
 */
export const SYNC_AUDIT_SEVERITIES = ["info", "warning", "critical"] as const;
export type SyncAuditSeverity = (typeof SYNC_AUDIT_SEVERITIES)[number];

/**
 * Flashcard self-ratings accepted in Phase 16. Flashcards cannot be objectively
 * regraded, so only these two self-ratings are honoured; `hard`/`easy` are
 * rejected for flashcards (phases-16.md §11, ARCHITECTURE.md §2).
 */
export const FLASHCARD_ALLOWED_RATINGS = ["again", "good"] as const;
export type FlashcardAllowedRating = (typeof FLASHCARD_ALLOWED_RATINGS)[number];

/**
 * Request/response bounds. Enforced at the wire schema and re-checked at the
 * route boundary (phases-16.md §9.1, §30). Values are deliberately generous
 * for a legitimate session-end batch but bounded to cap resource use.
 */
export const SYNC_BOUNDS = {
  /** Maximum decoded request body size (bytes) before parsing. */
  maxRequestBytes: 1_000_000,
  /** Per-kind item caps. */
  maxAttempts: 500,
  maxEvents: 500,
  maxRevocations: 200,
  maxBookmarks: 500,
  maxLists: 100,
  maxSettings: 50,
  /** Total items across all kinds in one push. */
  maxItemsPerBatch: 1_000,
  /** Maximum entries in a single custom-list membership snapshot. */
  maxListEntries: 1_000,
  /** Custom-list display-name length (mirrors custom_lists_name_length_check). */
  maxListNameLength: 60,
  /** Generic bounded string / id lengths. */
  maxIdLength: 64,
  maxComponentKeyLength: 160,
  maxShortStringLength: 256,
  maxTimezoneLength: 64,
  /** Pull page size cap (phases-16.md §30 — bound pull page size). */
  maxPullPageSize: 200,
  defaultPullPageSize: 100,
  /**
   * Maximum pending-parent events one component may hold at once (EXT-F4). A
   * held child waits for its (unarrived) parent; capping the backlog bounds the
   * authenticated storage a client can pin with events whose parents never come.
   */
  maxPendingPerComponent: 500,
  /**
   * How long a pending-parent event may wait for its parent before it is
   * considered expired (EXT-F4). Expired holds are never promoted and may be
   * purged; 30 days is well beyond any legitimate offline gap in Stage A.
   */
  pendingTtlMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/** Reason codes that classify as recoverable (client can repair + resubmit). */
export const RECOVERABLE_REASON_CODES: ReadonlySet<SyncReasonCode> = new Set([
  "pending_parent",
  "stale_branch_conflict",
  "invalid_release",
  "revoked_release",
  "unsupported_generator_version",
  // Stage A head-only revocation (design D2): revoking a non-head event is a
  // RECOVERABLE rejection — the client revokes the descendants first (or
  // pulls/rebases) and resubmits, rather than the server inventing chain
  // demotion or producing a broken chain (phases-16.md §16).
  "revocation_has_descendants",
  "internal_error",
  // EXT-F4: a full pending backlog is transient — the client retries once the
  // parent arrives directly or the backlog is purged.
  "pending_quota_exceeded",
]);

/** True when a rejection is safe for the client to retry after repair/pull. */
export function isRecoverableReason(code: SyncReasonCode): boolean {
  return RECOVERABLE_REASON_CODES.has(code);
}
