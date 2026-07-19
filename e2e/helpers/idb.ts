/**
 * Shared raw-IndexedDB helpers for specs that seed or read app state directly
 * (bypassing the UI), independent of app code. Every existing spec that needs
 * this currently duplicates it locally; this is the first spec to factor it
 * out — existing specs are left with their own copies (out of scope to
 * retrofit here).
 */
import type { Page } from "@playwright/test";

const DB_NAME = "safwa-content";

/** Read every row of an app IndexedDB object store. */
export function idbAll(page: Page, store: string): Promise<unknown[]> {
  return page.evaluate(
    async ({ dbName, store }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) return [];
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
  return page.evaluate(
    async ({ dbName, store }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(store)) return 0;
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
    { dbName: DB_NAME, store, rows },
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
