import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SafwaDb,
  type ReviewEventRecord,
  type StudyAttemptRecord,
} from "@/modules/content/db";
import {
  accountOwnerKey,
  GUEST_OWNER_KEY,
  type OwnerKey,
} from "@/modules/content/owner-key";
import type { GuestListMapping } from "@/modules/sync/protocol";

import { readGuestImport } from "./guest-import-key";
import { finaliseGuestMerge } from "./guest-merge-finalise";
import type { GuestSnapshot } from "./guest-snapshot";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = accountOwnerKey(USER);
const IMPORT_KEY = "0192f9a0-1111-7abc-8def-0123456789ab";
const NOW = Date.parse("2026-07-28T09:00:00.000Z");
const COMPONENT =
  "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-merge-finalise-test-${counter++}`);
  await db.open();
  await db.guestImports.put({
    userId: USER,
    importKey: IMPORT_KEY,
    snapshotHash: "a".repeat(64),
    status: "uploading",
    createdAt: NOW - 1000,
    uploadedItems: 2,
  });
});
afterEach(() => db.close());

/**
 * Finalisation reads an attempt's `id` and `ownerKey` and writes the row back
 * unchanged apart from the owner, so the stored engine `attempt` payload is
 * irrelevant here and is left off rather than reproduced in full — a 30-field
 * fixture would say nothing about re-keying.
 */
function attempt(
  id: string,
  ownerKey: OwnerKey,
  sessionId = "session-1",
): StudyAttemptRecord {
  return {
    id,
    ownerKey,
    componentKey: COMPONENT,
    sessionId,
    attemptedAt: NOW - 5000,
  };
}

function session(id: string, ownerKey: OwnerKey) {
  return { id, ownerKey, startedAt: NOW - 6000 };
}

function event(
  eventId: string,
  ownerKey: OwnerKey,
  overrides: Partial<ReviewEventRecord> = {},
): ReviewEventRecord {
  return {
    eventId,
    componentKey: COMPONENT,
    ownerKey,
    parentEventId: null,
    clientComponentRevision: 1,
    syncStatus: "local",
    createdAt: NOW - 5000,
    status: "scheduling",
    ...overrides,
  };
}

/**
 * A snapshot naming exactly the rows this import carried.
 *
 * Finalisation reads ONLY the identity fields off a snapshot — `attempts[].id`,
 * `events[].eventId`, `bookmarks[].entryId`, `lists[].id`, `settings[].key` —
 * because the snapshot's job here is to answer "was this row part of the
 * completed import?" and nothing else. The rest of each wire record is asserted
 * away rather than reproduced: a fully-populated `WireAttempt` per case would
 * add thirty fields that no assertion in this file depends on, and would make a
 * future schema addition look like a test failure in the merge logic.
 */
function snapshot(named: {
  attemptIds?: string[];
  eventIds?: string[];
  entryIds?: number[];
  listIds?: string[];
  settingKeys?: string[];
}): GuestSnapshot {
  return {
    version: 1,
    deviceId: "device-1",
    attempts: (named.attemptIds ?? []).map((id) => ({
      id,
    })) as GuestSnapshot["attempts"],
    events: (named.eventIds ?? []).map((eventId) => ({
      eventId,
    })) as unknown as GuestSnapshot["events"],
    bookmarks: (named.entryIds ?? []).map((entryId) => ({
      entryId,
    })) as unknown as GuestSnapshot["bookmarks"],
    lists: (named.listIds ?? []).map((id) => ({
      id,
    })) as unknown as GuestSnapshot["lists"],
    settings: (named.settingKeys ?? []).map((key) => ({
      key,
    })) as unknown as GuestSnapshot["settings"],
    skipped: { events: 0, attempts: 0, bookmarks: 0, lists: 0, settings: 0 },
  };
}

function run(
  snap: GuestSnapshot,
  listIdMappings: GuestListMapping[] = [],
): ReturnType<typeof finaliseGuestMerge> {
  return finaliseGuestMerge(db, {
    userId: USER,
    importKey: IMPORT_KEY,
    snapshot: snap,
    listIdMappings,
    now: NOW,
  });
}

describe("finaliseGuestMerge — ownership conversion", () => {
  it("re-keys imported attempts and events WITHOUT changing their ids", async () => {
    // §9.4/§10: the server's idempotency and the imported chain's parent links
    // both key on these ids. Minting new ones turns a completed import into a
    // second one on the next sync.
    const attemptId = randomUUID();
    const eventId = randomUUID();
    await db.studyAttempts.put(attempt(attemptId, GUEST_OWNER_KEY));
    await db.reviewEvents.put(event(eventId, GUEST_OWNER_KEY));

    const report = await run(
      snapshot({ attemptIds: [attemptId], eventIds: [eventId] }),
    );

    expect(report).toMatchObject({ attemptsReKeyed: 1, eventsReKeyed: 1 });
    expect((await db.studyAttempts.get(attemptId))?.ownerKey).toBe(ACCOUNT);
    expect((await db.reviewEvents.get(eventId))?.ownerKey).toBe(ACCOUNT);
  });

  it("marks a re-keyed event as accepted so ordinary sync never re-uploads it", async () => {
    // §20.10. A re-keyed event still marked `local` is selected by the ordinary
    // push as unsynced work and sent again — as a fresh root, which the server
    // then rejects as a stale branch, and that device stops recording reviews.
    const eventId = randomUUID();
    await db.reviewEvents.put(event(eventId, GUEST_OWNER_KEY));
    await run(snapshot({ eventIds: [eventId] }));
    expect((await db.reviewEvents.get(eventId))?.syncStatus).toBe("accepted");
  });

  it("leaves a guest row the snapshot never carried alone", async () => {
    // §20.12: rows created after collection, or refused, are still the
    // learner's and are still merge-able later. Deleting them on the strength
    // of someone else's success is the data loss this guards.
    const imported = randomUUID();
    const later = randomUUID();
    await db.studyAttempts.bulkPut([
      attempt(imported, GUEST_OWNER_KEY),
      attempt(later, GUEST_OWNER_KEY),
    ]);

    const report = await run(snapshot({ attemptIds: [imported] }));

    expect(report.attemptsReKeyed).toBe(1);
    expect(report.leftForLater.attempts).toBe(1);
    expect((await db.studyAttempts.get(later))?.ownerKey).toBe(GUEST_OWNER_KEY);
  });

  it("moves a session only once no guest attempt still points at it (REL-001)", async () => {
    // An earlier version moved every guest session unconditionally. That splits
    // one session across two owners: the account holds a session whose leftover
    // attempts it cannot see, and those leftover guest attempts reference a
    // session that no longer exists under the guest key — so the recovery path
    // §20.12 promises them would have no session metadata to show.
    const imported = randomUUID();
    const later = randomUUID();
    await db.studyAttempts.bulkPut([
      attempt(imported, GUEST_OWNER_KEY, "session-shared"),
      attempt(later, GUEST_OWNER_KEY, "session-shared"),
    ]);
    await db.sessions.put(session("session-shared", GUEST_OWNER_KEY) as never);

    const report = await run(snapshot({ attemptIds: [imported] }));

    expect(report.sessionsReKeyed).toBe(0);
    expect(report.leftForLater.sessions).toBe(1);
    expect((await db.sessions.get("session-shared"))?.ownerKey).toBe(
      GUEST_OWNER_KEY,
    );
  });

  it("moves a session once its whole attempt set has moved", async () => {
    const imported = randomUUID();
    await db.studyAttempts.put(
      attempt(imported, GUEST_OWNER_KEY, "session-whole"),
    );
    await db.sessions.put(session("session-whole", GUEST_OWNER_KEY) as never);

    const report = await run(snapshot({ attemptIds: [imported] }));

    expect(report.sessionsReKeyed).toBe(1);
    expect((await db.sessions.get("session-whole"))?.ownerKey).toBe(ACCOUNT);
  });
});

describe("finaliseGuestMerge — the account's row wins", () => {
  it("drops a guest bookmark the account already had rather than overwriting it", async () => {
    // The compound key means a blind re-key would replace the account's own
    // createdAt with the guest's. The server's union kept the account's row.
    await db.bookmarks.put({
      ownerKey: ACCOUNT,
      entryId: 7,
      createdAt: NOW - 100_000,
    });
    await db.bookmarks.put({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 7,
      createdAt: NOW - 50,
    });

    const report = await run(snapshot({ entryIds: [7] }));

    expect(report.supersededByAccount).toBe(1);
    expect(report.bookmarksReKeyed).toBe(0);
    expect((await db.bookmarks.get([ACCOUNT, 7]))?.createdAt).toBe(
      NOW - 100_000,
    );
    expect(await db.bookmarks.get([GUEST_OWNER_KEY, 7])).toBeUndefined();
  });

  it("moves a guest bookmark the account did not have", async () => {
    await db.bookmarks.put({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 9,
      createdAt: NOW - 50,
    });
    const report = await run(snapshot({ entryIds: [9] }));
    expect(report.bookmarksReKeyed).toBe(1);
    expect(await db.bookmarks.get([ACCOUNT, 9])).toBeDefined();
  });

  it("keeps the account's setting and discards the guest's", async () => {
    // §18 is account-wins; the guest's value only ever fills a gap.
    await db.settings.put({
      ownerKey: ACCOUNT,
      key: "theme",
      value: "dark",
      updatedAt: NOW - 100,
    });
    await db.settings.put({
      ownerKey: GUEST_OWNER_KEY,
      key: "theme",
      value: "light",
      updatedAt: NOW - 10,
    });

    await run(snapshot({ settingKeys: ["theme"] }));

    expect((await db.settings.get([ACCOUNT, "theme"]))?.value).toBe("dark");
    expect(await db.settings.get([GUEST_OWNER_KEY, "theme"])).toBeUndefined();
  });

  it("fills a setting gap from the guest", async () => {
    await db.settings.put({
      ownerKey: GUEST_OWNER_KEY,
      key: "fontScale",
      value: 1.2,
      updatedAt: NOW - 10,
    });
    const report = await run(snapshot({ settingKeys: ["fontScale"] }));
    expect(report.settingsReKeyed).toBe(1);
    expect((await db.settings.get([ACCOUNT, "fontScale"]))?.value).toBe(1.2);
  });
});

describe("finaliseGuestMerge — list id re-keying (§17)", () => {
  it("keeps a list whose uuid the server preserved", async () => {
    const listId = randomUUID();
    await db.lists.put({
      ownerKey: GUEST_OWNER_KEY,
      id: listId,
      name: "Verbs",
      entryIds: [1, 2],
      createdAt: NOW - 100,
      updatedAt: NOW - 100,
    });

    const report = await run({ ...snapshot({ listIds: [listId] }) }, [
      { guestListId: listId, accountListId: listId },
    ]);

    expect(report.listsReKeyed).toBe(1);
    expect((await db.lists.get(listId))?.ownerKey).toBe(ACCOUNT);
  });

  it("drops a guest list folded into an account list of the same name", async () => {
    // The guest id no longer names anything. Keeping it would either duplicate
    // the list on the next sync or lose the membership just merged.
    const guestListId = randomUUID();
    const accountListId = randomUUID();
    await db.lists.put({
      ownerKey: ACCOUNT,
      id: accountListId,
      name: "Verbs",
      entryIds: [1, 2, 3],
      createdAt: NOW - 500,
      updatedAt: NOW,
    });
    await db.lists.put({
      ownerKey: GUEST_OWNER_KEY,
      id: guestListId,
      name: "verbs",
      entryIds: [3],
      createdAt: NOW - 100,
      updatedAt: NOW - 100,
    });

    const report = await run(snapshot({ listIds: [guestListId] }), [
      { guestListId, accountListId },
    ]);

    expect(report.supersededByAccount).toBe(1);
    expect(await db.lists.get(guestListId)).toBeUndefined();
    expect((await db.lists.get(accountListId))?.entryIds).toEqual([1, 2, 3]);
  });

  it("leaves a list the server did not map, rather than assuming it succeeded", async () => {
    // An unmapped list is one the server did not accept. Deleting it would
    // destroy the only copy on the strength of an assumption.
    const listId = randomUUID();
    await db.lists.put({
      ownerKey: GUEST_OWNER_KEY,
      id: listId,
      name: "Nouns",
      entryIds: [4],
      createdAt: NOW - 100,
      updatedAt: NOW - 100,
    });

    const report = await run(snapshot({ listIds: [listId] }), []);

    expect(report.leftForLater.lists).toBe(1);
    expect((await db.lists.get(listId))?.ownerKey).toBe(GUEST_OWNER_KEY);
  });
});

describe("finaliseGuestMerge — derived state and completion", () => {
  it("drops a guest component projection whose whole history moved", async () => {
    // The projection is derived and was never uploaded; the account's post-merge
    // card comes from the server's own replay. Promoting a client projection
    // would put a card the server never derived in front of the learner.
    const eventId = randomUUID();
    await db.reviewEvents.put(event(eventId, GUEST_OWNER_KEY));
    await db.studyComponents.put({
      ownerKey: GUEST_OWNER_KEY,
      componentKey: COMPONENT,
      entryId: 1,
      revision: 1,
      learnerState: "learning",
    });

    const report = await run(snapshot({ eventIds: [eventId] }));

    expect(report.componentsDropped).toBe(1);
    expect(
      await db.studyComponents.get([GUEST_OWNER_KEY, COMPONENT]),
    ).toBeUndefined();
  });

  it("keeps the projection of a component the guest still has history for", async () => {
    // Studied again after collection: those events are still merge-able later
    // and would have nothing to schedule from without their projection.
    const imported = randomUUID();
    const later = randomUUID();
    await db.reviewEvents.bulkPut([
      event(imported, GUEST_OWNER_KEY),
      event(later, GUEST_OWNER_KEY),
    ]);
    await db.studyComponents.put({
      ownerKey: GUEST_OWNER_KEY,
      componentKey: COMPONENT,
      entryId: 1,
      revision: 2,
      learnerState: "learning",
    });

    const report = await run(snapshot({ eventIds: [imported] }));

    expect(report.componentsDropped).toBe(0);
    expect(
      await db.studyComponents.get([GUEST_OWNER_KEY, COMPONENT]),
    ).toBeDefined();
  });

  it("marks the import completed only at the very end", async () => {
    // §20: the database must never claim a completed merge while only half the
    // ownership conversion committed, so the upload driver deliberately does
    // not set this — finalisation does.
    expect((await readGuestImport(db, USER))?.status).toBe("uploading");
    await run(snapshot({}));
    expect((await readGuestImport(db, USER))?.status).toBe("completed");
  });

  it("leaves the account sync cursor untouched, so the next pull brings the merge down", async () => {
    // §20.7. Advancing it to the merge's own serverCursor would skip precisely
    // the rows the merge wrote — the device would believe it was up to date
    // with a merge it never received.
    await db.syncState.put({
      key: "account",
      userId: USER,
      serverCursor: 12,
      lastSyncAt: NOW - 1000,
    });
    await run(snapshot({}));
    expect((await db.syncState.get("account"))?.serverCursor).toBe(12);
  });

  it("does not touch the account's pending mutation queue", async () => {
    // §20.8 names "stale imported guest queue entries", and a guest never
    // enqueues — so a sweep here would be deleting an account's genuinely
    // pending work under a guest's name.
    await db.mutationQueue.put({
      idempotencyKey: "k1",
      type: "bookmark",
      userId: USER,
      status: "pending",
      target: "7",
      payload: {},
      createdAt: NOW,
      attempts: 0,
    } as never);
    await run(snapshot({}));
    expect(await db.mutationQueue.count()).toBe(1);
  });

  it("is safe to run twice — a retried finalisation changes nothing more", async () => {
    // A finalisation that fails halfway must be re-runnable WITHOUT re-running
    // the server import, and the second run must not undo or double-count the
    // first.
    const attemptId = randomUUID();
    const eventId = randomUUID();
    await db.studyAttempts.put(attempt(attemptId, GUEST_OWNER_KEY));
    await db.reviewEvents.put(event(eventId, GUEST_OWNER_KEY));
    const snap = snapshot({ attemptIds: [attemptId], eventIds: [eventId] });

    const first = await run(snap);
    const second = await run(snap);

    expect(first).toMatchObject({ attemptsReKeyed: 1, eventsReKeyed: 1 });
    expect(second).toMatchObject({
      attemptsReKeyed: 0,
      eventsReKeyed: 0,
      leftForLater: {
        attempts: 0,
        events: 0,
        sessions: 0,
        bookmarks: 0,
        lists: 0,
        settings: 0,
      },
    });
    expect((await db.studyAttempts.get(attemptId))?.ownerKey).toBe(ACCOUNT);
  });
});
