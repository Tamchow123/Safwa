import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import type { PullResponse, WireComponentState } from "@/modules/sync/protocol";

import { applyPullResponse } from "./reconcile";
import { readCursorForAccount } from "./sync-state";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-reconcile-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

const CARD = {
  stability: 3.2,
  difficulty: 5.1,
  dueAtMs: 1_800_000_000_000,
  state: "review" as const,
  reps: 2,
  lapses: 0,
  scheduledDays: 4,
  learningSteps: 0,
  lastReviewAtMs: 1_700_000_000_000,
};

function component(
  overrides: Partial<WireComponentState> = {},
): WireComponentState {
  return {
    componentKey:
      "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english",
    entryId: 1,
    skillType: "meaning_recognition",
    componentShape: "form_direction",
    sourceField: "madi",
    direction: "arabic_to_english",
    revision: 2,
    learnerState: "learning",
    card: CARD,
    masteryDates: [],
    ...overrides,
  };
}

function pull(overrides: Partial<PullResponse> = {}): PullResponse {
  return {
    protocolVersion: 1,
    serverCursor: 9,
    activeReleaseId: "rel-1",
    hasMore: false,
    components: [],
    events: [],
    bookmarks: [],
    lists: [],
    settings: [],
    tombstones: [],
    notices: [],
    ...overrides,
  };
}

describe("applyPullResponse", () => {
  it("upserts authoritative component state and advances the cursor", async () => {
    const comp = component();
    await applyPullResponse(db, "user-1", pull({ components: [comp] }), 1000);

    const stored = await db.studyComponents.get(comp.componentKey);
    expect(stored?.revision).toBe(2);
    expect(stored?.learnerState).toBe("learning");
    expect(stored?.fsrs).toEqual(CARD);
    expect(await readCursorForAccount(db, "user-1")).toBe(9);
  });

  it("marks a known synced event by server status but preserves a local one", async () => {
    await db.reviewEvents.add({
      eventId: "ev-synced",
      componentKey: "c",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "pushed",
      createdAt: 1,
    });
    await db.reviewEvents.add({
      eventId: "ev-local",
      componentKey: "c",
      parentEventId: null,
      clientComponentRevision: 2,
      syncStatus: "local",
      createdAt: 2,
    });

    await applyPullResponse(
      db,
      "user-1",
      pull({
        events: [
          {
            eventId: "ev-synced",
            studyComponentId: "c",
            status: "revoked",
            syncSeq: 9,
          },
          {
            eventId: "ev-local",
            studyComponentId: "c",
            status: "scheduling",
            syncSeq: 9,
          },
        ],
      }),
      1000,
    );

    const synced = await db.reviewEvents.get("ev-synced");
    expect(synced?.status).toBe("revoked");
    expect(synced?.syncStatus).toBe("rejected");
    // The not-yet-pushed local event is untouched.
    const local = await db.reviewEvents.get("ev-local");
    expect(local?.syncStatus).toBe("local");
  });

  it("upserts bookmarks, lists and settings", async () => {
    await applyPullResponse(
      db,
      "user-1",
      pull({
        bookmarks: [{ entryId: 5, createdAt: 100 }],
        lists: [
          {
            id: "l1",
            name: "Verbs",
            entryIds: [1, 2],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        settings: [{ key: "theme", value: "dark", updatedAt: 3 }],
      }),
      1000,
    );
    expect(await db.bookmarks.get(5)).toMatchObject({ entryId: 5 });
    expect((await db.lists.get("l1"))?.entryIds).toEqual([1, 2]);
    expect((await db.settings.get("theme"))?.value).toBe("dark");
  });

  it("maps pulled server settings back to the LOCAL keys/shapes so context B can read them (EXT-F2)", async () => {
    await applyPullResponse(
      db,
      "user-1",
      pull({
        settings: [
          { key: "arabicFontScale", value: "large", updatedAt: 3 },
          {
            key: "timezone",
            value: { mode: "iana", name: "Europe/London" },
            updatedAt: 4,
          },
          { key: "questionCount", value: 15, updatedAt: 5 },
          { key: "dailyReviewTarget", value: 40, updatedAt: 6 },
        ],
      }),
      1000,
    );
    // The camelCase server keys land under the LOCAL kebab keys the app reads.
    expect((await db.settings.get("arabic-font-scale"))?.value).toBe("large");
    expect((await db.settings.get("timezone"))?.value).toEqual({
      mode: "iana",
      timezone: "Europe/London",
    });
    // The four session-defaults keys merge into the one local blob.
    expect((await db.settings.get("session-defaults"))?.value).toMatchObject({
      questionCount: 15,
      reviewsPerDay: 40,
    });
    // The camelCase keys are NOT left lying around as unreadable rows.
    expect(await db.settings.get("arabicFontScale")).toBeUndefined();
    expect(await db.settings.get("questionCount")).toBeUndefined();
  });

  it("applies tombstones by deleting the named bookmark and list", async () => {
    await db.bookmarks.add({ entryId: 5, createdAt: 1 });
    await db.lists.add({
      id: "l1",
      name: "X",
      entryIds: [],
      createdAt: 1,
      updatedAt: 1,
    });

    await applyPullResponse(
      db,
      "user-1",
      pull({
        tombstones: [
          { kind: "bookmark", ref: "5", syncSeq: 9 },
          { kind: "list", ref: "l1", syncSeq: 9 },
        ],
      }),
      1000,
    );
    expect(await db.bookmarks.get(5)).toBeUndefined();
    expect(await db.lists.get("l1")).toBeUndefined();
  });

  it("retains local study attempts (never deletes history)", async () => {
    await db.studyAttempts.add({
      id: "a1",
      componentKey: "c",
      sessionId: "s1",
      attemptedAt: 1,
    });
    await applyPullResponse(
      db,
      "user-1",
      pull({ components: [component()] }),
      1000,
    );
    expect(await db.studyAttempts.get("a1")).toMatchObject({ id: "a1" });
  });

  it("is idempotent — re-applying the same page converges", async () => {
    const page = pull({
      components: [component()],
      bookmarks: [{ entryId: 5, createdAt: 100 }],
    });
    await applyPullResponse(db, "user-1", page, 1000);
    await applyPullResponse(db, "user-1", page, 2000);
    expect(await db.studyComponents.count()).toBe(1);
    expect(await db.bookmarks.count()).toBe(1);
    expect(await readCursorForAccount(db, "user-1")).toBe(9);
  });
});
