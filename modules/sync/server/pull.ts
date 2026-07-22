/**
 * Phase 16 — pull / rebase (§9.3, §19, design D1). Returns the account's
 * authoritative changes since a client-known cursor so a second browser context
 * can bootstrap or reconcile.
 *
 * The account cursor (`user_sync_state.sync_revision`) is monotonic: every
 * authoritative change stamps the rows it touched with the new value. Pull
 * returns rows with `last_sync_seq > since`, ordered by that cursor, targeting
 * ~`limit` rows per page. Pagination is GAP-FREE: a page never splits a "cursor
 * group" (all rows sharing one `last_sync_seq`, i.e. one push's changes), so a
 * client advancing `since = serverCursor` can never skip a row. `hasMore`
 * signals a further page.
 *
 * PAGE-SIZE BOUND: `limit` targets the page size, but because a cursor group is
 * never split, a single push that stamped a large group (up to
 * `SYNC_BOUNDS.maxItemsPerBatch` rows) is always returned whole in one page —
 * so the true worst-case page is bounded by the push-batch cap, not `limit`.
 * That upper bound is what sizes response/timeout budgets. Intra-group paging
 * (a secondary row-id cursor) is a future concern if pushes get much larger.
 *
 * All queries are scoped to the session `userId` (no cross-account reads).
 * Authoritative component state (the full FSRS card + effective learner state +
 * mastery dates) is re-derived deterministically by replaying the component's
 * accepted events — the same replay the ingest path used (§15).
 *
 * `server-only`.
 */
import "server-only";

import { and, asc, type Column, eq, gt, inArray, lte } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import {
  bookmarks,
  customListEntries,
  customLists,
  reviewEvents,
  studyComponents,
  syncTombstones,
  userSettings,
} from "@/db/schema";
import type {
  ComponentShape,
  Direction,
  SkillType,
  SourceQuizFormField,
} from "@/modules/content/constants";
import { buildComponentKey } from "@/modules/study-engine";
import type {
  WireComponentState,
  WireEventStatus,
  WireTombstone,
} from "@/modules/sync/protocol";

import { currentAccountCursor } from "./cursor";
import { type ComponentReplayEvent, projectComponentForPull } from "./replay";
import { extractSyncableSettings } from "./settings";

export type PullQueryInput = { since: number; limit: number };
export type PullOptions = {
  /** Injected clock (epoch ms) for the effective learner-state projection. */
  nowMs: number;
};

export type PullChanges = {
  serverCursor: number;
  hasMore: boolean;
  components: WireComponentState[];
  events: WireEventStatus[];
  bookmarks: { entryId: number; createdAt: number }[];
  lists: {
    id: string;
    name: string;
    entryIds: number[];
    createdAt: number;
    updatedAt: number;
  }[];
  settings: { key: string; value: unknown; updatedAt: number }[];
  tombstones: WireTombstone[];
};

type ComponentRow = typeof studyComponents.$inferSelect;
type EventRow = typeof reviewEvents.$inferSelect;

/** Rebuild a component's natural key from its stored identity. */
function componentKeyOf(row: ComponentRow): string {
  return buildComponentKey({
    entryId: row.entryId,
    skillType: row.skillTypeId as SkillType,
    componentShape: row.componentShape as ComponentShape,
    sourceField: row.sourceField as SourceQuizFormField | null,
    direction: row.direction as Direction | null,
  });
}

function toReplayEvent(row: EventRow): ComponentReplayEvent {
  return {
    eventId: row.eventId,
    status: row.status as ComponentReplayEvent["status"],
    rating: row.rating as ComponentReplayEvent["rating"],
    clientComponentRevision: row.clientComponentRevision,
    parentEventId: row.parentEventId,
    occurredAtCanonical: row.occurredAtCanonical,
    localDateAtEvent: row.localDateAtEvent,
  };
}

/**
 * Gather candidate cursor values (`last_sync_seq > since`) from every source,
 * bounded to `limit` each, to pick this page's ceiling without loading rows.
 */
async function candidateSeqs(
  db: Database,
  userId: string,
  since: number,
  limit: number,
): Promise<number[]> {
  const samples = await Promise.all([
    db
      .select({ seq: studyComponents.lastSyncSeq })
      .from(studyComponents)
      .where(
        and(
          eq(studyComponents.userId, userId),
          gt(studyComponents.lastSyncSeq, since),
        ),
      )
      .orderBy(asc(studyComponents.lastSyncSeq))
      .limit(limit),
    db
      .select({ seq: reviewEvents.lastSyncSeq })
      .from(reviewEvents)
      .where(
        and(
          eq(reviewEvents.userId, userId),
          gt(reviewEvents.lastSyncSeq, since),
        ),
      )
      .orderBy(asc(reviewEvents.lastSyncSeq))
      .limit(limit),
    db
      .select({ seq: bookmarks.lastSyncSeq })
      .from(bookmarks)
      .where(
        and(eq(bookmarks.userId, userId), gt(bookmarks.lastSyncSeq, since)),
      )
      .orderBy(asc(bookmarks.lastSyncSeq))
      .limit(limit),
    db
      .select({ seq: customLists.lastSyncSeq })
      .from(customLists)
      .where(
        and(eq(customLists.userId, userId), gt(customLists.lastSyncSeq, since)),
      )
      .orderBy(asc(customLists.lastSyncSeq))
      .limit(limit),
    db
      .select({ seq: userSettings.lastSyncSeq })
      .from(userSettings)
      .where(
        and(
          eq(userSettings.userId, userId),
          gt(userSettings.lastSyncSeq, since),
        ),
      )
      .orderBy(asc(userSettings.lastSyncSeq))
      .limit(limit),
    db
      .select({ seq: syncTombstones.lastSyncSeq })
      .from(syncTombstones)
      .where(
        and(
          eq(syncTombstones.userId, userId),
          gt(syncTombstones.lastSyncSeq, since),
        ),
      )
      .orderBy(asc(syncTombstones.lastSyncSeq))
      .limit(limit),
  ]);
  return samples
    .flatMap((rows) => rows.map((row) => row.seq))
    .sort((a, b) => a - b);
}

/**
 * Pull the account's changes since `since` as one bounded, gap-free page. When
 * there are no changes, returns an empty page at the current account cursor.
 */
export async function pullChanges(
  userId: string,
  query: PullQueryInput,
  options: PullOptions,
): Promise<PullChanges> {
  const db = getDb();
  const { since, limit } = query;

  const seqs = await candidateSeqs(db, userId, since, limit);
  if (seqs.length === 0) {
    const serverCursor = await currentAccountCursor(db, userId);
    return {
      serverCursor,
      hasMore: false,
      components: [],
      events: [],
      bookmarks: [],
      lists: [],
      settings: [],
      tombstones: [],
    };
  }
  // The ceiling is the cursor value of the `limit`-th changed row; pass 2 then
  // fetches ALL rows with `last_sync_seq <= ceiling`, so the page always
  // contains complete cursor groups (gap-free) while staying ~`limit` rows.
  const ceiling = seqs[Math.min(limit, seqs.length) - 1]!;
  const inPage = (col: Column) => and(gt(col, since), lte(col, ceiling));

  // --- components (+ their event-status rows) ---
  const componentRows = await db
    .select()
    .from(studyComponents)
    .where(
      and(
        eq(studyComponents.userId, userId),
        inPage(studyComponents.lastSyncSeq),
      ),
    );

  const componentIds = componentRows.map((row) => row.id);
  const schedulingByComponent = new Map<string, EventRow[]>();
  if (componentIds.length > 0) {
    const scheduling = await db
      .select()
      .from(reviewEvents)
      .where(
        and(
          inArray(reviewEvents.studyComponentId, componentIds),
          eq(reviewEvents.status, "scheduling"),
        ),
      );
    for (const row of scheduling) {
      const list = schedulingByComponent.get(row.studyComponentId) ?? [];
      list.push(row);
      schedulingByComponent.set(row.studyComponentId, list);
    }
  }

  const keyByComponentId = new Map<string, string>();
  const components: WireComponentState[] = componentRows.map((row) => {
    const key = componentKeyOf(row);
    keyByComponentId.set(row.id, key);
    const projection = projectComponentForPull(
      (schedulingByComponent.get(row.id) ?? []).map(toReplayEvent),
      options.nowMs,
    );
    return {
      componentKey: key,
      entryId: row.entryId,
      skillType: row.skillTypeId as SkillType,
      componentShape: row.componentShape as ComponentShape,
      sourceField: row.sourceField as SourceQuizFormField | null,
      direction: row.direction as Direction | null,
      revision: row.revision,
      learnerState: projection.state,
      card: projection.card,
      masteryDates: projection.masteryDates,
    };
  });

  // --- event status updates (accepted → revoked / pending resolved) ---
  const changedEvents = await db
    .select()
    .from(reviewEvents)
    .where(
      and(eq(reviewEvents.userId, userId), inPage(reviewEvents.lastSyncSeq)),
    );

  // Resolve componentKey for any event whose component wasn't already loaded.
  const missingIds = [
    ...new Set(
      changedEvents
        .map((event) => event.studyComponentId)
        .filter((id) => !keyByComponentId.has(id)),
    ),
  ];
  if (missingIds.length > 0) {
    const extra = await db
      .select()
      .from(studyComponents)
      .where(
        and(
          eq(studyComponents.userId, userId),
          inArray(studyComponents.id, missingIds),
        ),
      );
    for (const row of extra) keyByComponentId.set(row.id, componentKeyOf(row));
  }
  const events: WireEventStatus[] = changedEvents.map((event) => {
    const componentKey = keyByComponentId.get(event.studyComponentId);
    if (componentKey === undefined) {
      // Every event is same-account and FK-linked to a component we load above
      // (scoped by userId), so this is unreachable. Fail loud rather than emit
      // an empty componentKey, which would violate the wire schema (min length 1).
      throw new Error(`pull: no component key for event ${event.eventId}`);
    }
    return {
      eventId: event.eventId,
      studyComponentId: componentKey,
      status: event.status as WireEventStatus["status"],
      syncSeq: event.lastSyncSeq,
    };
  });

  // --- bookmarks ---
  const bookmarkRows = await db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), inPage(bookmarks.lastSyncSeq)));
  const bookmarkOut = bookmarkRows.map((row) => ({
    entryId: row.entryId,
    createdAt: row.createdAt.getTime(),
  }));

  // --- custom lists (+ membership) ---
  const listRows = await db
    .select()
    .from(customLists)
    .where(
      and(eq(customLists.userId, userId), inPage(customLists.lastSyncSeq)),
    );
  const listIds = listRows.map((row) => row.id);
  const membershipByList = new Map<string, number[]>();
  if (listIds.length > 0) {
    const memberRows = await db
      .select()
      .from(customListEntries)
      .where(inArray(customListEntries.listId, listIds));
    for (const row of memberRows) {
      const list = membershipByList.get(row.listId) ?? [];
      list.push(row.entryId);
      membershipByList.set(row.listId, list);
    }
  }
  const listOut = listRows.map((row) => ({
    id: row.id,
    name: row.name,
    entryIds: (membershipByList.get(row.id) ?? []).sort((a, b) => a - b),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }));

  // --- settings (columnar row → per-key wire settings) ---
  const settingsRows = await db
    .select()
    .from(userSettings)
    .where(
      and(eq(userSettings.userId, userId), inPage(userSettings.lastSyncSeq)),
    );
  // The syncable key vocabulary + column extraction is single-sourced in
  // settings.ts (compiler-enforced complete) so pull and push can never drift.
  const settingsOut = settingsRows.flatMap((row) => {
    const updatedAt = row.updatedAt.getTime();
    return extractSyncableSettings(row).map((setting) => ({
      ...setting,
      updatedAt,
    }));
  });

  // --- tombstones ---
  const tombstoneRows = await db
    .select()
    .from(syncTombstones)
    .where(
      and(
        eq(syncTombstones.userId, userId),
        inPage(syncTombstones.lastSyncSeq),
      ),
    );
  const tombstoneOut: WireTombstone[] = tombstoneRows.map((row) => ({
    kind: row.kind as WireTombstone["kind"],
    ref: row.ref,
    syncSeq: row.lastSyncSeq,
  }));

  // More pages remain iff the account's monotonic high-water cursor is beyond
  // this page's ceiling — a single indexed lookup instead of per-table probes.
  // (Every cursor bump stamps at least one row, so this equals "a row exists
  // with last_sync_seq > ceiling"; in the rare event a bump left no stamped row,
  // the worst case is one extra empty pull, never a skipped change.)
  const hasMore = (await currentAccountCursor(db, userId)) > ceiling;

  return {
    serverCursor: ceiling,
    hasMore,
    components,
    events,
    bookmarks: bookmarkOut,
    lists: listOut,
    settings: settingsOut,
    tombstones: tombstoneOut,
  };
}
