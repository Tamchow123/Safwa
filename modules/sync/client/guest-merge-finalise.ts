/**
 * Phase 17 §20 — LOCAL finalisation and rebase, after the server merge succeeded.
 *
 * The server now holds the guest's history under the account. This module makes
 * the DEVICE agree, and its whole design is about one asymmetry: the server side
 * is already durable, so nothing here may re-run it, and nothing here may claim
 * it did not happen.
 *
 * WHAT IT DOES, IN THE ORDER IT MATTERS (§20).
 *
 *  1. **Re-key, do not copy.** Guest-owned attempts, events and sessions become
 *     account-owned in place. Their globally-unique ids are PRESERVED (§9.4,
 *     §10) — the server's idempotency and the imported chain's own lineage both
 *     key on them, so minting new ids would turn a completed import into a
 *     second one on the next sync.
 *  2. **The account's own row wins, always.** Where a guest row and an account
 *     row share a natural key — a bookmark for the same entry, a setting, a
 *     component projection — the account's is authoritative and the guest's is
 *     dropped rather than written over it (§16-§18). The server already decided
 *     these unions; re-deciding them locally is how the two answers drift.
 *  3. **List ids are re-keyed from the server's mapping** (§17). A guest list
 *     folded into an account list of the same normalised name no longer exists
 *     under its own id; without applying the mapping the device would either
 *     duplicate the list on its next sync or lose the membership just merged.
 *  4. **Imported rows are marked synced** (§20.10). A re-keyed event still
 *     carrying `syncStatus: "local"` would be pushed again as new work.
 *  5. **Derived caches are rebuilt from the merged raw history** (§20.9),
 *     through the one shared writer, so the dashboard cannot show a
 *     pre-merge streak next to post-merge cards.
 *  6. **Guest rows go last, and only what was actually imported** (§20.11-12).
 *     Anything the snapshot did not carry — rows added after collection, rows
 *     the server refused — stays guest-owned, so it is still there to merge
 *     later rather than being deleted on the strength of someone else's success.
 *
 * WHY IT IS RETRYABLE AND WHY THAT IS THE POINT. Every step is idempotent, and
 * the import is marked `completed` only at the very end. If finalisation fails
 * halfway, the next attempt re-runs it — it does NOT re-run the server import,
 * because `begin` on a completed key returns `already_completed` and sends
 * nothing (§20 "store enough state to retry finalisation without reapplying the
 * server import"). The durable `guest_imports` row IS that state.
 *
 * TWO OF §20'S STEPS ARE DELIBERATELY NO-OPS HERE, and saying so is better than
 * leaving a reader to wonder which were forgotten.
 *
 *  - **The account sync cursor is left exactly where it was** (§20.7). The merge
 *    stamped the rows it wrote with cursor values ABOVE the device's `since`, so
 *    the next ordinary pull fetches the whole merged result and the authoritative
 *    component projections with it. Advancing the cursor to the merge's own
 *    `serverCursor` would skip precisely those rows — the device would believe it
 *    was up to date with a merge it never received.
 *  - **There are no imported guest queue entries to remove** (§20.8). The
 *    mutation queue is the account's outbound work and a guest never enqueues
 *    (`clearAccountLocalState` relies on the same fact). Sweeping it here would
 *    be deleting an account's genuinely pending mutations under a guest's name.
 *
 * THE TRANSACTION SHAPE. §20 asks for "the smallest safe Dexie transaction set"
 * and forbids the database claiming a completed local merge when only half the
 * ownership conversion committed. So the ownership conversion — re-key, drop
 * superseded guest rows, mark synced, apply list mappings — is ONE transaction,
 * and it either happens or does not. The cache rebuild and the completion mark
 * follow as separate steps, because both are safely repeatable and neither can
 * leave a half-owned row behind.
 *
 * Browser-only (Dexie). The clock is injected.
 */
import { rebuildDailyActivity } from "@/modules/analytics/persistence";
import {
  ownerScopedTables,
  type BookmarkRecord,
  type CustomListRecord,
  type SafwaDb,
  type SettingRecord,
  type StudyComponentRecord,
} from "@/modules/content/db";
import {
  accountOwnerKey,
  GUEST_OWNER_KEY,
  type OwnerKey,
} from "@/modules/content/owner-key";
import type { GuestListMapping } from "@/modules/sync/protocol";

import { markGuestImportCompleted } from "./guest-import-key";
import type { GuestSnapshot } from "./guest-snapshot";

/**
 * Guest rows deliberately LEFT guest-owned, per kind. Per kind rather than one
 * total (REL-003) because "5 rows still to merge" cannot tell a learner whether
 * a study session's worth of history is waiting or one setting is — and those
 * are not the same message.
 */
export type GuestMergeLeftForLater = {
  attempts: number;
  events: number;
  sessions: number;
  bookmarks: number;
  lists: number;
  settings: number;
};

/** What finalisation actually changed locally, for the summary and for tests. */
export type GuestMergeFinaliseReport = {
  attemptsReKeyed: number;
  eventsReKeyed: number;
  sessionsReKeyed: number;
  bookmarksReKeyed: number;
  listsReKeyed: number;
  settingsReKeyed: number;
  /**
   * Guest component projections dropped as superseded.
   *
   * ALSO A DEPENDENCY THE CALLER MUST ACT ON (REL-002): each of these
   * components now has NO local card until an ordinary pull brings the server's
   * own replay down. That is the correct authority (§7 — a client projection is
   * never authoritative), but it means a merge followed by a failed or deferred
   * pull leaves the learner looking at components with nothing scheduled. A
   * non-zero count here obliges the caller to drive the pull to success, with
   * bounded retry, and to say "restoring your history" rather than presenting
   * an empty deck as the finished merge.
   */
  componentsDropped: number;
  /** Guest rows dropped because the account already had that natural key. */
  supersededByAccount: number;
  leftForLater: GuestMergeLeftForLater;
};

function emptyReport(): GuestMergeFinaliseReport {
  return {
    attemptsReKeyed: 0,
    eventsReKeyed: 0,
    sessionsReKeyed: 0,
    bookmarksReKeyed: 0,
    listsReKeyed: 0,
    settingsReKeyed: 0,
    componentsDropped: 0,
    supersededByAccount: 0,
    leftForLater: {
      attempts: 0,
      events: 0,
      sessions: 0,
      bookmarks: 0,
      lists: 0,
      settings: 0,
    },
  };
}

/** Total rows left guest-owned, for a caller that wants only the headline. */
export function totalLeftForLater(report: GuestMergeFinaliseReport): number {
  const left = report.leftForLater;
  return (
    left.attempts +
    left.events +
    left.sessions +
    left.bookmarks +
    left.lists +
    left.settings
  );
}

/** Everything finalisation needs from the merge that just succeeded. */
export type GuestMergeFinaliseInput = {
  userId: string;
  importKey: string;
  /** Exactly what was uploaded — the authority on which guest rows are settled. */
  snapshot: GuestSnapshot;
  /** Guest-list-id → account-list-id, from the server's finalisation (§17). */
  listIdMappings: readonly GuestListMapping[];
  /** Injected clock, stamped onto the rebuilt derived cache. */
  now: number;
};

/**
 * The ids the snapshot actually carried, per kind. A guest row NOT named here
 * was never part of this import — it was created after collection, or skipped as
 * unsendable — so finalisation must leave it guest-owned (§20.12).
 */
type Imported = {
  attemptIds: Set<string>;
  eventIds: Set<string>;
  entryIds: Set<number>;
  listIds: Set<string>;
  settingKeys: Set<string>;
};

function importedOf(snapshot: GuestSnapshot): Imported {
  return {
    attemptIds: new Set(snapshot.attempts.map((a) => a.id)),
    eventIds: new Set(snapshot.events.map((e) => e.eventId)),
    entryIds: new Set(snapshot.bookmarks.map((b) => b.entryId)),
    listIds: new Set(snapshot.lists.map((l) => l.id)),
    settingKeys: new Set(snapshot.settings.map((s) => s.key)),
  };
}

/**
 * Convert every guest-owned local row this import carried into an account-owned
 * one, and mark the import complete.
 *
 * Safe to call repeatedly: a second run finds nothing left guest-owned and
 * changes nothing. That is what makes a half-finished finalisation recoverable
 * without touching the server.
 */
export async function finaliseGuestMerge(
  db: SafwaDb,
  input: GuestMergeFinaliseInput,
): Promise<GuestMergeFinaliseReport> {
  const account = accountOwnerKey(input.userId);
  const imported = importedOf(input.snapshot);
  const listIdOf = new Map(
    input.listIdMappings.map((m) => [m.guestListId, m.accountListId]),
  );
  const report = emptyReport();

  // --- the ownership conversion: one transaction, all or nothing (§20) ------
  //
  // The scope is `ownerScopedTables`, not a hand-written list (CLEAN-001).
  // `db.ts` names that function the single source of truth for this
  // security-relevant grouping precisely so the scoped sign-out cleanup and this
  // re-keying iterate the SAME set — a new private store must be classified
  // there or it silently escapes both. A local copy of the list would let a
  // future store be added to one and forgotten by the other, which for this
  // module means guest-owned rows quietly surviving a completed merge.
  //
  // That set includes `daily_activity`, which this transaction never writes:
  // it is derived, and it is rebuilt from the converted history immediately
  // afterwards. Naming it in the scope costs nothing and is the price of not
  // re-deriving the grouping here.
  await db.transaction("rw", ownerScopedTables(db), async () => {
    await reKeyAttemptsAndEvents(db, account, imported, report);
    // AFTER the attempts, deliberately: it decides from what is left.
    await reKeySessions(db, account, report);
    await reKeyBookmarks(db, account, imported, report);
    await reKeyLists(db, account, imported, listIdOf, report);
    await reKeySettings(db, account, imported, report);
    // AFTER the events, deliberately: it decides from what is left.
    await dropGuestComponents(db, report);
  });

  // --- derived caches, from the merged raw history (§20.9) ------------------
  // Outside the conversion transaction on purpose: it is a pure re-derivation
  // of rows the transaction above already committed, so repeating it is free and
  // failing it cannot strand a half-owned row. Its own writer is atomic.
  await rebuildDailyActivity(db, input.now, input.userId);
  // The guest's own derived cache now describes history that is no longer
  // theirs. Rebuilding it from what actually remains keeps a deferred second
  // merge honest rather than showing the guest a streak they no longer own.
  await rebuildDailyActivity(db, input.now, null);

  // --- only now is the merge finished (§20) --------------------------------
  await markGuestImportCompleted(db, input.userId, input.importKey);
  return report;
}

/**
 * Attempts and events keep their primary keys — only `ownerKey` moves — so the
 * server's idempotency and the imported chain's parent links both survive. An
 * event also stops being unsynced work: it is already on the server.
 */
async function reKeyAttemptsAndEvents(
  db: SafwaDb,
  account: OwnerKey,
  imported: Imported,
  report: GuestMergeFinaliseReport,
): Promise<void> {
  const attempts = await db.studyAttempts
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  for (const attempt of attempts) {
    if (!imported.attemptIds.has(attempt.id)) {
      report.leftForLater.attempts += 1;
      continue;
    }
    await db.studyAttempts.put({ ...attempt, ownerKey: account });
    report.attemptsReKeyed += 1;
  }

  const events = await db.reviewEvents
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  for (const event of events) {
    if (!imported.eventIds.has(event.eventId)) {
      report.leftForLater.events += 1;
      continue;
    }
    await db.reviewEvents.put({
      ...event,
      ownerKey: account,
      // §20.10: a re-keyed event still marked `local` would be selected by the
      // ordinary push as unsynced work and uploaded a second time — as a fresh
      // root, which the server would then reject as a stale branch.
      syncStatus: "accepted",
    });
    report.eventsReKeyed += 1;
  }
}

/**
 * Sessions are not uploaded and have no natural key to collide on, but a guest
 * session whose attempts are now the account's would otherwise leave the
 * session list showing that study as belonging to nobody.
 *
 * GATED ON THE ATTEMPTS, NOT ON THE SNAPSHOT (REL-001). A session is only moved
 * once NO guest-owned attempt still points at it — read after the re-keying
 * above, in the same transaction, exactly as `dropGuestComponents` reads the
 * remaining events. Moving it unconditionally would split a session across two
 * owners: the account would hold a session whose leftover attempts it cannot
 * see, and those leftover guest attempts would reference a session that no
 * longer exists under the guest key, so the recovery path §20.12 promises them
 * would have no session metadata to show.
 */
async function reKeySessions(
  db: SafwaDb,
  account: OwnerKey,
  report: GuestMergeFinaliseReport,
): Promise<void> {
  const remainingAttempts = await db.studyAttempts
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  const stillGuestOwned = new Set(remainingAttempts.map((a) => a.sessionId));

  const sessions = await db.sessions
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  for (const session of sessions) {
    if (stillGuestOwned.has(session.id)) {
      report.leftForLater.sessions += 1;
      continue;
    }
    await db.sessions.put({ ...session, ownerKey: account });
    report.sessionsReKeyed += 1;
  }
}

/**
 * A bookmark is identified by `[ownerKey+entryId]`, so re-keying one the
 * account already holds would overwrite the account's own `createdAt` with the
 * guest's. The server's union kept the ACCOUNT's row (§16); the guest's is
 * dropped so the device says the same thing.
 */
async function reKeyBookmarks(
  db: SafwaDb,
  account: OwnerKey,
  imported: Imported,
  report: GuestMergeFinaliseReport,
): Promise<void> {
  const bookmarks = await db.bookmarks
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  for (const bookmark of bookmarks) {
    if (!imported.entryIds.has(bookmark.entryId)) {
      report.leftForLater.bookmarks += 1;
      continue;
    }
    const existing = await db.bookmarks.get([account, bookmark.entryId]);
    await db.bookmarks.delete([GUEST_OWNER_KEY, bookmark.entryId]);
    if (existing) {
      report.supersededByAccount += 1;
      continue;
    }
    const moved: BookmarkRecord = { ...bookmark, ownerKey: account };
    await db.bookmarks.put(moved);
    report.bookmarksReKeyed += 1;
  }
}

/**
 * A list's primary key is its globally-unique id, so re-keying is a put — but
 * the id itself may have changed: a guest list folded into an account list of
 * the same normalised name now lives under the ACCOUNT's id (§17). Where the
 * mapping points elsewhere, the guest row is deleted rather than moved, because
 * the account's list already holds the merged membership the server produced.
 */
async function reKeyLists(
  db: SafwaDb,
  account: OwnerKey,
  imported: Imported,
  listIdOf: Map<string, string>,
  report: GuestMergeFinaliseReport,
): Promise<void> {
  const lists = await db.lists
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  for (const list of lists) {
    if (!imported.listIds.has(list.id)) {
      report.leftForLater.lists += 1;
      continue;
    }
    // A list the server did not map is one it did not accept. Left guest-owned
    // rather than assumed successful — assuming would delete the only copy.
    const accountListId = listIdOf.get(list.id);
    if (accountListId === undefined) {
      report.leftForLater.lists += 1;
      continue;
    }
    await db.lists.delete(list.id);
    if (accountListId !== list.id) {
      // Folded into an existing account list. The account's row is already
      // there, carrying the union the server computed; nothing to write.
      report.supersededByAccount += 1;
      continue;
    }
    const moved: CustomListRecord = { ...list, ownerKey: account };
    await db.lists.put(moved);
    report.listsReKeyed += 1;
  }
}

/**
 * Settings merge account-wins (§18): the guest's value fills a gap or is
 * discarded. Either way the guest row goes, and the account's is left exactly
 * as the authoritative pull will confirm it.
 */
async function reKeySettings(
  db: SafwaDb,
  account: OwnerKey,
  imported: Imported,
  report: GuestMergeFinaliseReport,
): Promise<void> {
  const settings = await db.settings
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  for (const setting of settings) {
    if (!imported.settingKeys.has(setting.key)) {
      report.leftForLater.settings += 1;
      continue;
    }
    const existing = await db.settings.get([account, setting.key]);
    await db.settings.delete([GUEST_OWNER_KEY, setting.key]);
    if (existing) {
      report.supersededByAccount += 1;
      continue;
    }
    const moved: SettingRecord = { ...setting, ownerKey: account };
    await db.settings.put(moved);
    report.settingsReKeyed += 1;
  }
}

/**
 * Guest component projections are DERIVED, never uploaded and never
 * authoritative (§12 excludes them from the snapshot for exactly this reason).
 * The account's post-merge cards come from the server's replay on the next
 * pull, so the guest's are dropped rather than re-keyed — promoting a client
 * projection to account-owned state would put a card the server never derived
 * in front of the learner.
 *
 * Which components those are is read off the events RATHER than off the
 * snapshot: this runs after the re-keying above, so a component with no
 * guest-owned events left is precisely one whose whole history moved. A
 * component the guest studied after collection still has guest events, so its
 * projection stays — those events are still merge-able later and would have
 * nothing to schedule from without it.
 */
async function dropGuestComponents(
  db: SafwaDb,
  report: GuestMergeFinaliseReport,
): Promise<void> {
  const components: StudyComponentRecord[] = await db.studyComponents
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  const remainingEvents = await db.reviewEvents
    .where("ownerKey")
    .equals(GUEST_OWNER_KEY)
    .toArray();
  const stillGuestOwned = new Set(remainingEvents.map((e) => e.componentKey));
  for (const component of components) {
    if (stillGuestOwned.has(component.componentKey)) continue;
    await db.studyComponents.delete([GUEST_OWNER_KEY, component.componentKey]);
    report.componentsDropped += 1;
  }
}
