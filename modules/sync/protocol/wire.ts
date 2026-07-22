/**
 * Phase 16 online-sync wire protocol — Zod request/response schemas.
 *
 * PURE and isomorphic (see ./constants.ts). Every schema is `strictObject`, so
 * unknown fields are rejected rather than silently dropped — no arbitrary
 * nested blobs reach the server (phases-16.md §9.1). Trust boundary: these
 * schemas validate SHAPE and BOUNDS only. Semantic trust (correctness, rating,
 * eligibility, lineage) is derived server-side and never taken from the wire
 * (phases-16.md §8.1).
 *
 * Field names mirror the client's camelCase record types; Postgres columns are
 * snake_case and mapped declaratively by Drizzle (e.g. db/schema/collections.ts
 * `entryId: integer("entry_id")`), so no second hand-written casing layer
 * exists. Enum vocabularies are imported from their single canonical pure
 * source (modules/scheduler, modules/study-engine) — never re-declared here.
 */
import { z } from "zod";

import { answerReferenceSchema } from "@/modules/content/answer-reference";
import {
  ANSWER_FIELDS,
  COMPONENT_SHAPES,
  DIRECTIONS,
  SKILL_TYPES,
  SOURCE_QUIZ_FORM_FIELDS,
} from "@/modules/content/constants";
import { REVIEW_EVENT_STATUSES } from "@/modules/scheduler/events";
import { FSRS_STATE_VALUES, SCHEDULER_RATINGS } from "@/modules/scheduler/fsrs";
import { LEARNER_STATE_VALUES } from "@/modules/scheduler/states";
import { TIMEZONE_SOURCES } from "@/modules/study-engine/attempts";
import { DELIVERY_MODES, HINT_TYPES } from "@/modules/study-engine/generator";

import {
  SYNC_BOUNDS,
  SYNC_ITEM_KINDS,
  SYNC_ITEM_STATUSES,
  SYNC_PROTOCOL_VERSION,
  SYNC_REASON_CODES,
} from "./constants";

// Re-export the canonical runtime enum arrays so downstream sync code has one
// import site for the wire vocabulary without reaching past this boundary — and
// without ever re-declaring the literals (single source of truth; see the
// "never re-declare" note in modules/scheduler/fsrs.ts).
export {
  DELIVERY_MODES,
  FSRS_STATE_VALUES,
  HINT_TYPES,
  LEARNER_STATE_VALUES,
  REVIEW_EVENT_STATUSES,
  SCHEDULER_RATINGS,
  TIMEZONE_SOURCES,
};

// --- shared primitives -------------------------------------------------------

/** Generic UUID (any version — the client mints uuidv7). */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidSchema = z.string().regex(UUID_PATTERN, "invalid uuid");

const boundedId = z.string().min(1).max(SYNC_BOUNDS.maxIdLength);
const componentKeySchema = z
  .string()
  .min(1)
  .max(SYNC_BOUNDS.maxComponentKeyLength);
const shortString = z.string().min(1).max(SYNC_BOUNDS.maxShortStringLength);
const timezoneName = z.string().min(1).max(SYNC_BOUNDS.maxTimezoneLength);

/** Epoch milliseconds, bounded to a sane range (0 .. year ~2100). */
const MAX_EPOCH_MS = 4_102_444_800_000;
const epochMs = z.number().int().min(0).max(MAX_EPOCH_MS);
const epochMsNullable = epochMs.nullable();

/** ISO-8601 instant with offset/Z, bounded length. */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const isoInstantSchema = z
  .string()
  .max(40)
  .regex(ISO_INSTANT_PATTERN, "invalid ISO-8601 instant");
/** Local calendar date "YYYY-MM-DD". */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid local date");

const utcOffsetMinutes = z.number().int().min(-1080).max(1080);

/** Event-time metadata recorded by the client (phases-16.md §13). */
export const eventTimeFieldsSchema = z.strictObject({
  occurredAtUtc: isoInstantSchema,
  timezoneAtEvent: timezoneName,
  utcOffsetMinutesAtEvent: utcOffsetMinutes,
  localDateAtEvent: localDateSchema,
  timezoneSource: z.enum(TIMEZONE_SOURCES),
});

// --- push items --------------------------------------------------------------

/**
 * An attempt record as submitted for grading. `isCorrect`, `rating`-adjacent
 * fields and `correctAnswerRef` are CLAIMS retained only for diagnostics/audit;
 * the server reconstructs the question and derives correctness independently
 * (phases-16.md §8.1, §10). Shape mirrors `AttemptRecord`.
 */
export const wireAttemptSchema = z.strictObject({
  id: uuidSchema,
  sessionId: uuidSchema,
  deviceId: boundedId,
  studyComponentId: componentKeySchema,
  entryId: z.number().int().min(1),
  skillTypeId: z.enum(SKILL_TYPES),
  sourceField: z.enum(SOURCE_QUIZ_FORM_FIELDS).nullable(),
  direction: z.enum(DIRECTIONS).nullable(),
  promptField: z.enum(ANSWER_FIELDS),
  promptRef: answerReferenceSchema,
  selectedAnswerRef: answerReferenceSchema.nullable(),
  correctAnswerRef: answerReferenceSchema,
  isCorrect: z.boolean(),
  isFirstAttempt: z.boolean(),
  isReinforcement: z.boolean(),
  hintUsed: z.boolean(),
  hintType: z.enum(HINT_TYPES).nullable(),
  responseTimeMs: z.number().int().min(0).max(86_400_000),
  questionPosition: z.number().int().min(0).max(100_000),
  mode: z.enum(DELIVERY_MODES),
  optionCount: z
    .number()
    .int()
    .min(2)
    .max(8)
    .nullable()
    .optional()
    .default(null),
  perQuestionLimitMs: z.number().int().min(0).max(3_600_000).nullable(),
  questionInstanceId: shortString,
  questionSeed: shortString,
  questionGeneratorVersion: z.string().min(1).max(16),
  releaseId: shortString,
  contentVersion: z.string().min(1).max(64),
  ...eventTimeFieldsSchema.shape,
});
export type WireAttempt = z.infer<typeof wireAttemptSchema>;

/**
 * A scheduling review event. `rating` and `status` are client claims; the
 * server derives the authoritative rating from the linked attempt and enforces
 * scheduling-authoritative status (phases-16.md §8.1, §12). Shape mirrors
 * `ReviewEvent`.
 */
export const wireEventSchema = z.strictObject({
  eventId: uuidSchema,
  studyComponentId: componentKeySchema,
  attemptId: uuidSchema,
  rating: z.enum(SCHEDULER_RATINGS),
  status: z.enum(REVIEW_EVENT_STATUSES),
  baseServerRevision: z.number().int().min(0),
  parentEventId: uuidSchema.nullable(),
  clientComponentRevision: z.number().int().min(0),
  clientSequence: z.number().int().min(0),
  occurredAtClient: isoInstantSchema,
  deviceId: boundedId,
  sessionId: uuidSchema,
  releaseId: shortString,
  contentVersion: z.string().min(1).max(64),
  timezoneAtEvent: timezoneName,
  utcOffsetMinutesAtEvent: utcOffsetMinutes,
  localDateAtEvent: localDateSchema,
  timezoneSource: z.enum(TIMEZONE_SOURCES),
});
export type WireEvent = z.infer<typeof wireEventSchema>;

/** A post-sync undo: revoke an already-accepted scheduling event. */
export const wireRevocationSchema = z.strictObject({
  revocationId: uuidSchema,
  eventId: uuidSchema,
  studyComponentId: componentKeySchema,
  deviceId: boundedId,
  occurredAtClient: isoInstantSchema,
});
export type WireRevocation = z.infer<typeof wireRevocationSchema>;

/** A bookmark upsert (`deleted:false`) or delete (`deleted:true`). */
export const wireBookmarkSchema = z.strictObject({
  entryId: z.number().int().min(1),
  createdAt: epochMs,
  deleted: z.boolean(),
});
export type WireBookmark = z.infer<typeof wireBookmarkSchema>;

/** A custom list with a canonical membership snapshot, or a deletion. */
export const wireListSchema = z.strictObject({
  id: uuidSchema,
  name: z.string().min(1).max(SYNC_BOUNDS.maxListNameLength),
  entryIds: z.array(z.number().int().min(1)).max(SYNC_BOUNDS.maxListEntries),
  createdAt: epochMs,
  updatedAt: epochMs,
  deleted: z.boolean(),
});
export type WireList = z.infer<typeof wireListSchema>;

/**
 * An account setting update. `value` is validated per-key against the server
 * allowlist (phases-16.md §23); the wire only bounds the key and rejects
 * unknown top-level structure. `value` is intentionally `unknown` here and is
 * never spread/merged into an object server-side (no prototype pollution).
 */
export const wireSettingSchema = z.strictObject({
  key: z.string().min(1).max(64),
  value: z.unknown(),
  updatedAt: epochMs,
});
export type WireSetting = z.infer<typeof wireSettingSchema>;

// --- push request ------------------------------------------------------------

export const pushRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    deviceId: boundedId,
    attempts: z
      .array(wireAttemptSchema)
      .max(SYNC_BOUNDS.maxAttempts)
      .default([]),
    events: z.array(wireEventSchema).max(SYNC_BOUNDS.maxEvents).default([]),
    revocations: z
      .array(wireRevocationSchema)
      .max(SYNC_BOUNDS.maxRevocations)
      .default([]),
    bookmarks: z
      .array(wireBookmarkSchema)
      .max(SYNC_BOUNDS.maxBookmarks)
      .default([]),
    lists: z.array(wireListSchema).max(SYNC_BOUNDS.maxLists).default([]),
    settings: z
      .array(wireSettingSchema)
      .max(SYNC_BOUNDS.maxSettings)
      .default([]),
  })
  // The per-kind `.max()` caps sum to more than the intended total budget
  // (500+500+200+500+100+50 = 1850 > maxItemsPerBatch). Enforce the total cap
  // at parse time so it can never be forgotten by a route handler
  // (phases-16.md §9.1, §30). `totalPushItemCount` is hoisted below.
  .refine(
    (request) => totalPushItemCount(request) <= SYNC_BOUNDS.maxItemsPerBatch,
    {
      error: `push batch exceeds ${SYNC_BOUNDS.maxItemsPerBatch} total items`,
    },
  );
export type PushRequest = z.infer<typeof pushRequestSchema>;

/** Total item count across every kind. Also enforced by pushRequestSchema. */
export function totalPushItemCount(request: {
  attempts: readonly unknown[];
  events: readonly unknown[];
  revocations: readonly unknown[];
  bookmarks: readonly unknown[];
  lists: readonly unknown[];
  settings: readonly unknown[];
}): number {
  return (
    request.attempts.length +
    request.events.length +
    request.revocations.length +
    request.bookmarks.length +
    request.lists.length +
    request.settings.length
  );
}

// --- authoritative component state (shared by push results and pull) ---------

/** An FSRS card as reconciled by the server (mirrors `SchedulerCard`). */
export const wireCardSchema = z.strictObject({
  stability: z.number(),
  difficulty: z.number(),
  dueAtMs: epochMs,
  state: z.enum(FSRS_STATE_VALUES),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  scheduledDays: z.number(),
  learningSteps: z.number().int().min(0),
  lastReviewAtMs: epochMsNullable,
});
export type WireCard = z.infer<typeof wireCardSchema>;

/** Authoritative component state the client rebases onto (phases-16.md §19). */
export const wireComponentStateSchema = z.strictObject({
  componentKey: componentKeySchema,
  entryId: z.number().int().min(1),
  skillType: z.enum(SKILL_TYPES),
  componentShape: z.enum(COMPONENT_SHAPES),
  sourceField: z.enum(SOURCE_QUIZ_FORM_FIELDS).nullable(),
  direction: z.enum(DIRECTIONS).nullable(),
  revision: z.number().int().min(0),
  learnerState: z.enum(LEARNER_STATE_VALUES),
  card: wireCardSchema.nullable(),
  masteryDates: z.array(localDateSchema).max(4096),
});
export type WireComponentState = z.infer<typeof wireComponentStateSchema>;

// --- per-item result + push response ----------------------------------------

export const syncItemResultSchema = z.strictObject({
  itemId: shortString,
  itemKind: z.enum(SYNC_ITEM_KINDS),
  status: z.enum(SYNC_ITEM_STATUSES),
  reasonCode: z.enum(SYNC_REASON_CODES),
  duplicate: z.boolean(),
  recoverable: z.boolean(),
  componentKey: componentKeySchema.optional(),
  serverRevision: z.number().int().min(0).optional(),
  componentState: wireComponentStateSchema.optional(),
  clockSuspect: z.boolean().optional(),
  canonicalOccurredAt: isoInstantSchema.optional(),
});
export type SyncItemResult = z.infer<typeof syncItemResultSchema>;

export const pushResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  serverCursor: z.number().int().min(0),
  activeReleaseId: shortString,
  results: z.array(syncItemResultSchema),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

// --- pull request + response -------------------------------------------------

export const pullQuerySchema = z.strictObject({
  since: z.number().int().min(0).default(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SYNC_BOUNDS.maxPullPageSize)
    .default(SYNC_BOUNDS.defaultPullPageSize),
});
export type PullQuery = z.infer<typeof pullQuerySchema>;

/** An event status update surfaced by pull (e.g. accepted → revoked). */
export const wireEventStatusSchema = z.strictObject({
  eventId: uuidSchema,
  studyComponentId: componentKeySchema,
  status: z.enum(REVIEW_EVENT_STATUSES),
  syncSeq: z.number().int().min(0),
});
export type WireEventStatus = z.infer<typeof wireEventStatusSchema>;

export const wirePullBookmarkSchema = z.strictObject({
  entryId: z.number().int().min(1),
  createdAt: epochMs,
});
export const wirePullListSchema = z.strictObject({
  id: uuidSchema,
  name: shortString,
  entryIds: z.array(z.number().int().min(1)).max(SYNC_BOUNDS.maxListEntries),
  createdAt: epochMs,
  updatedAt: epochMs,
});
export const wirePullSettingSchema = z.strictObject({
  key: z.string().min(1).max(64),
  value: z.unknown(),
  updatedAt: epochMs,
});

/** A deletion propagated to other browser contexts (phases-16.md §22). */
export const wireTombstoneSchema = z.strictObject({
  kind: z.enum(["bookmark", "list"]),
  ref: shortString,
  syncSeq: z.number().int().min(0),
});
export type WireTombstone = z.infer<typeof wireTombstoneSchema>;

/** A safe, non-blocking notice (e.g. client-upgrade recommended). */
export const wireNoticeSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(280),
});

export const pullResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  serverCursor: z.number().int().min(0),
  activeReleaseId: shortString,
  hasMore: z.boolean(),
  components: z.array(wireComponentStateSchema),
  events: z.array(wireEventStatusSchema),
  bookmarks: z.array(wirePullBookmarkSchema),
  lists: z.array(wirePullListSchema),
  settings: z.array(wirePullSettingSchema),
  tombstones: z.array(wireTombstoneSchema),
  notices: z.array(wireNoticeSchema).default([]),
});
export type PullResponse = z.infer<typeof pullResponseSchema>;
