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

import { and, asc, type Column, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import {
  bookmarks,
  customListEntries,
  customLists,
  reviewEvents,
  studyComponents,
  syncAuditLog,
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
  WireWithheldComponent,
} from "@/modules/sync/protocol";

import { writeSyncAudit } from "./audit";
import { selectHead } from "./chain-head";
import { componentFaultReason } from "./component-fault";
import { currentAccountCursor } from "./cursor";
import { type ComponentReplayEvent, projectComponentForPull } from "./replay";
import { extractSyncableSettings } from "./settings";

/**
 * How long one withheld component stays audited-recently-enough to skip a
 * repeat entry (REL-101). Long enough that a device stuck on one cursor cannot
 * flood the log, short enough that a condition an operator fixed and which then
 * returns is raised again rather than silently suppressed.
 *
 * Measured against the DATABASE clock, not the injected `nowMs`: the column it
 * is compared with is written by `defaultNow()`, so using the request's clock
 * would compare two different clocks — and `nowMs` is a test seam that
 * legitimately sits years away from real time.
 */
const WITHHELD_AUDIT_WINDOW = sql`interval '24 hours'`;

export type PullQueryInput = { since: number; limit: number };
export type PullOptions = {
  /** Injected clock (epoch ms) for the effective learner-state projection. */
  nowMs: number;
};

export type PullChanges = {
  serverCursor: number;
  hasMore: boolean;
  components: WireComponentState[];
  /**
   * Components this page examined but could not project (REL-006). Never
   * silently dropped: pull advances its cursor past them regardless, so an
   * unnamed omission would make the component permanently invisible to this
   * device.
   */
  withheldComponents: WireWithheldComponent[];
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
 * Derive one component's authoritative wire state from its accepted scheduling
 * events. Throws (`ChainError` from replay, or anything else the projection
 * raises) when the stored chain cannot be replayed — the caller isolates that
 * per component rather than failing the whole page.
 */
function projectComponent(
  row: ComponentRow,
  key: string,
  schedulingRows: EventRow[],
  nowMs: number,
): WireComponentState {
  const projection = projectComponentForPull(
    schedulingRows.map(toReplayEvent),
    nowMs,
    { mergedAt: row.mergedAt },
  );
  // Lineage anchor (R2-F2). A fresh device parents its next review onto this,
  // rather than rooting a rejected stale branch — so the server has to name
  // the SAME head the ingestion side will demand, or the very next review it
  // sends back is rejected as a stale branch and that device silently stops
  // recording reviews for this component.
  //
  // Which is why this is `selectHead` and not the highest-revision scan it
  // used to be (Phase 17 §14): for a merged component the two disagree, since
  // the guest's and the account's chains each number from 1 and "highest
  // revision" names the longer history rather than the later event. For every
  // single-rooted component — which is all of them until a merge happens —
  // `selectHead` IS the highest-revision scan, so nothing changes.
  const head = selectHead(
    schedulingRows.map((e) => ({
      eventId: e.eventId,
      clientComponentRevision: e.clientComponentRevision,
      canonicalMs: e.occurredAtCanonical.getTime(),
      parentEventId: e.parentEventId,
    })),
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
    headEventId: head?.eventId ?? null,
    // Paired with the HEAD'S OWN revision, not the union maximum: replay
    // enforces contiguity per CHAIN, so the client's next event must be one past
    // the head it parents on, not one past the longest other history.
    headClientRevision: head?.clientComponentRevision ?? null,
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
      withheldComponents: [],
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
  const withheldComponents: WireWithheldComponent[] = [];
  // Per-component fault isolation (REL-006), matching ingest.ts and revoke.ts.
  // Before this, one component whose accepted chain cannot be replayed made the
  // WHOLE account's pull throw, denying every other component too — which broke
  // Phase 17 §17 ("imported list rows must be visible through ordinary Phase 16
  // pull on another device") for data that was perfectly fine.
  //
  // The failing component is withheld, NAMED on the response, and the page
  // ceiling still advances past it. Clamping the ceiling instead would stall
  // the device at that cursor forever — the same outage in a different shape.
  const components: WireComponentState[] = componentRows.flatMap((row) => {
    const key = componentKeyOf(row);
    keyByComponentId.set(row.id, key);
    const schedulingRows = schedulingByComponent.get(row.id) ?? [];
    try {
      return [projectComponent(row, key, schedulingRows, options.nowMs)];
    } catch (error) {
      console.error(`[sync] pull: component ${key} withheld`, error);
      withheldComponents.push({
        componentKey: key,
        // Same classifier the ingest/revoke boundaries use, so one condition
        // never has two names. The projection does no I/O — its rows are
        // already loaded — so in practice this is always the ChainError case.
        reasonCode: componentFaultReason(error),
      });
      return [];
    }
  });

  // Audit the withheld components out of band (REL-006): a permanent structural
  // condition has to be a monitoring signal, not just a server log line.
  //
  // REL-101: the write is rate-limited per (account, component, reason) rather
  // than relying on the client's cursor to move past the component. It usually
  // does — but the client persists that cursor in the SAME Dexie transaction as
  // the rest of the page, so ANY unrelated apply failure (quota, a bug in
  // another row on the page, a tab closed mid-commit) leaves `since` where it
  // was, and every later poll re-pulls the same component. Without this the
  // permanent condition would write one row per poll for the life of a stuck
  // device, drowning the very signal it exists to raise.
  for (const withheld of withheldComponents) {
    try {
      const [recent] = await db
        .select({ id: syncAuditLog.id })
        .from(syncAuditLog)
        .where(
          and(
            eq(syncAuditLog.userId, userId),
            eq(syncAuditLog.componentKey, withheld.componentKey),
            eq(syncAuditLog.reasonCode, withheld.reasonCode),
            sql`${syncAuditLog.createdAt} > now() - ${WITHHELD_AUDIT_WINDOW}`,
          ),
        )
        .limit(1);
      // Check-then-act, deliberately: two concurrent pulls can both miss and
      // write two rows. Bounded by concurrency rather than by poll count, which
      // is the property that matters here — an advisory lock or a unique index
      // would be real machinery to shave one duplicate row off a rare branch.
      if (recent) continue;
      await writeSyncAudit(db, {
        userId,
        // The audit item vocabulary is the PUSH item vocabulary and has no
        // "component" kind; the failure is in the component's event set, so the
        // entry is event-kinded and `componentKey` carries the identity.
        itemKind: "event",
        itemId: withheld.componentKey,
        reasonCode: withheld.reasonCode,
        severity: "critical",
        componentKey: withheld.componentKey,
      });
    } catch {
      // An audit write must never turn a partially-successful pull into a 500.
    }
  }

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
    withheldComponents,
    events,
    bookmarks: bookmarkOut,
    lists: listOut,
    settings: settingsOut,
    tombstones: tombstoneOut,
  };
}
