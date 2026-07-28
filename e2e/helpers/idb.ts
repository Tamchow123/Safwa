/**
 * Shared raw-IndexedDB helpers for specs that seed or read app state directly
 * (bypassing the UI), independent of app code.
 *
 * These helpers own the two things a spec must not get wrong since schema v7:
 * the logical→PHYSICAL store-name mapping (see PHYSICAL_STORE_NAMES) and the
 * guest OWNER stamped on seeded rows. auth, collections, dashboard and
 * weak-areas import them; bab-root-mixed, flashcards and mc-quiz still carry
 * their own local copies, which is safe only because they touch stores whose
 * physical names did not change (study_attempts, review_events) or were fixed
 * in place — a spec touching a renamed store MUST use these helpers instead.
 */
import type { Page } from "@playwright/test";

const DB_NAME = "safwa-content";

/**
 * The GUEST owner key (`modules/content/owner-key.ts`). Duplicated as a literal
 * because these helpers run inside `page.evaluate`, which cannot import app
 * code; `tests/content/owner-key.test.ts` pins the value it must equal.
 */
export const E2E_GUEST_OWNER_KEY = "guest";

/**
 * An owner key for a signed-in account, for the specs that need to seed a row
 * belonging to one — deletion cleanup in particular, where the whole point is
 * that the DELETED account's rows go while a guest's and any other account's
 * stay.
 *
 * Pass the REAL id when the row is meant to be swept: the cleanup is scoped to
 * one account (phases-17.md §11), so a made-up id survives because it belonged
 * to nobody rather than because the scoping worked. `userIdByEmail` in
 * `db-probe.ts` reads it from the database. The default is for the opposite
 * case — a bystander account whose rows must NOT be touched.
 */
export function e2eAccountOwnerKey(userId = "e2e-account"): string {
  return `account:${userId}`;
}

/**
 * Schema v7 (phases-17.md §10) re-keyed four stores to `[ownerKey+naturalKey]`,
 * which IndexedDB can only do by creating a new store — so their PHYSICAL names
 * changed and the v6 originals were dropped. Specs keep using the logical names
 * they always did; this map is the one place that knows the difference.
 */
export const PHYSICAL_STORE_NAMES: Record<string, string> = {
  study_components: "study_components_owned",
  bookmarks: "bookmarks_owned",
  settings: "settings_owned",
  daily_activity: "daily_activity_owned",
};

function physicalStore(store: string): string {
  return PHYSICAL_STORE_NAMES[store] ?? store;
}

/** Read every row of an app IndexedDB object store. */
export function idbAll(page: Page, store: string): Promise<unknown[]> {
  store = physicalStore(store);
  return page.evaluate(
    async ({ dbName, store }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) {
          throw new Error(
            `idbAll: store "${store}" not found — a stale physical name would make assertions pass vacuously`,
          );
        }
        return await new Promise<unknown[]>((resolve, reject) => {
          const request = database
            .transaction(store, "readonly")
            .objectStore(store)
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, store },
  );
}

/** Count rows in an app IndexedDB object store. */
export function idbCount(page: Page, store: string): Promise<number> {
  store = physicalStore(store);
  return page.evaluate(
    async ({ dbName, store }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) {
          throw new Error(
            `idbCount: store "${store}" not found — a stale physical name would make assertions pass vacuously`,
          );
        }
        return await new Promise<number>((resolve, reject) => {
          const request = database
            .transaction(store, "readonly")
            .objectStore(store)
            .count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, store },
  );
}

/**
 * Put rows into an app IndexedDB store. The schema must already exist —
 * `page.goto` a route that opens the Dexie database first (any page works;
 * the store itself only needs the app's schema upgrade to have run), THEN
 * seed, then reload for the app to read the seeded state fresh.
 */
export function idbSeed(
  page: Page,
  store: string,
  rows: readonly unknown[],
): Promise<void> {
  store = physicalStore(store);
  // Every private store is owner-keyed since schema v7, and a spec that seeds
  // learner state is seeding the GUEST's state unless it says otherwise — so
  // the owner is stamped here rather than in ~10 specs. An explicit `ownerKey`
  // on a row wins, for the specs that seed an account's rows.
  const owned = rows.map((row) =>
    typeof row === "object" && row !== null
      ? { ownerKey: E2E_GUEST_OWNER_KEY, ...row }
      : row,
  );
  return page.evaluate(
    async ({ dbName, store, rows }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) {
          throw new Error(
            `idbSeed: store "${store}" not found — navigate to the app first so its schema exists`,
          );
        }
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(store, "readwrite");
          const objectStore = transaction.objectStore(store);
          for (const row of rows) objectStore.put(row);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, store, rows: owned },
  );
}

/** A usable FSRS card due at `dueAtMs`, otherwise unremarkable. */
export function seedCard(
  dueAtMs: number,
  overrides: Partial<{
    lapses: number;
    state: string;
    reps: number;
  }> = {},
) {
  return {
    stability: 5,
    difficulty: 5,
    dueAtMs,
    state: overrides.state ?? "review",
    reps: overrides.reps ?? 3,
    lapses: overrides.lapses ?? 0,
    scheduledDays: 5,
    learningSteps: 0,
    lastReviewAtMs: dueAtMs - 2 * 86_400_000,
  };
}

/** A `bookmarks` row (Phase 14). */
export function seedBookmark(entryId: number, createdAtMs: number) {
  return { entryId, createdAt: createdAtMs };
}

/** A `lists` row (Phase 14) — `entryIds` defaults to empty (a bare list). */
export function seedList(params: {
  id: string;
  name: string;
  entryIds?: readonly number[];
  createdAtMs: number;
  updatedAtMs?: number;
}) {
  return {
    id: params.id,
    name: params.name,
    entryIds: [...(params.entryIds ?? [])],
    createdAt: params.createdAtMs,
    updatedAt: params.updatedAtMs ?? params.createdAtMs,
  };
}

/**
 * A `study_attempts` row shaped for Phase 13 weakness evidence
 * (`prepareWeaknessEvidence` excludes an attempt whose `entryId`/
 * `skillType`/`occurredAtUtc` is missing — every field below is required,
 * not decorative).
 */
export function seedWeakAttempt(params: {
  id: string;
  componentKey: string;
  entryId: number;
  skillTypeId: string;
  isCorrect: boolean;
  occurredAtMs: number;
  direction?: "arabic_to_english" | "english_to_arabic" | null;
  sourceField?: string | null;
  promptField?: string | null;
  isFirstAttempt?: boolean;
  isReinforcement?: boolean;
}) {
  const occurredAt = new Date(params.occurredAtMs);
  return {
    id: params.id,
    componentKey: params.componentKey,
    sessionId: "seeded-session",
    attemptedAt: params.occurredAtMs,
    attempt: {
      isFirstAttempt: params.isFirstAttempt ?? true,
      isCorrect: params.isCorrect,
      isReinforcement: params.isReinforcement ?? false,
      entryId: params.entryId,
      skillTypeId: params.skillTypeId,
      direction: params.direction ?? null,
      sourceField: params.sourceField ?? null,
      promptField: params.promptField ?? null,
      occurredAtUtc: occurredAt.toISOString(),
      localDateAtEvent: occurredAt.toISOString().slice(0, 10),
      responseTimeMs: 1_500,
    },
  };
}
