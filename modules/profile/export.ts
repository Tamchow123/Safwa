/**
 * Export-my-data: the guest safety valve. Serialises every local
 * learner-state store to a single JSON document the user can download and
 * keep. Content artifacts are NOT embedded (they are re-downloadable and
 * not the user's data); only the active release reference is included so a
 * future import/merge can pin what the state referred to.
 */
import type {
  BookmarkRecord,
  CustomListRecord,
  DeviceProfileRecord,
  LocalOwnerId,
  MutationQueueRecord,
  ReviewEventRecord,
  SafwaDb,
  SettingRecord,
  StudyAttemptRecord,
  StudyComponentRecord,
  StudySessionRecord,
} from "@/modules/content/db";
import { readOwnedRows } from "@/modules/content/owner-scope";

export const EXPORT_SCHEMA_VERSION = 1;

export type SafwaDataExport = {
  export_schema_version: number;
  app: "safwa";
  exported_at: string;
  /** Null when the guest never produced identity-requiring state. */
  device_profile: DeviceProfileRecord | null;
  /** Active content release reference at export time, if any. */
  active_content: { release_id: string; content_version: string } | null;
  settings: SettingRecord[];
  bookmarks: BookmarkRecord[];
  lists: CustomListRecord[];
  sessions: StudySessionRecord[];
  study_components: StudyComponentRecord[];
  study_attempts: StudyAttemptRecord[];
  review_events: ReviewEventRecord[];
  mutation_queue: MutationQueueRecord[];
};

/**
 * Snapshot the learner-state stores OWNED BY `owner` in one read transaction so
 * the export is internally consistent (no store read mid-write of another).
 *
 * OWNER-SCOPED (R2-F3 / ARCH-001, SEC-001). Since schema v6 a guest's and a
 * signed-in account's private rows can coexist in the same stores until the
 * sign-out wipe, so "export my data" must hand back only the ACTIVE identity's
 * rows — otherwise a shared device would let one identity download another's
 * bookmarks, lists, FSRS cards and review history, the exact disclosure the
 * sign-out wipe exists to prevent. `study_attempts` carries its owner inside the
 * engine payload (`attempt.userId`), the five v6 stores in their `userId`
 * column, and `mutation_queue` in its own `userId`.
 *
 * DEVICE-LEVEL, deliberately not scoped: `device_profile` (one anonymous device
 * id, no learner content), `sessions` (an id + a start timestamp, no learner
 * content, and no owner column to scope by) and `active_content` (the public
 * content release this device has cached).
 */
export async function buildExportPayload(
  db: SafwaDb,
  now: () => number = Date.now,
  owner: LocalOwnerId = null,
): Promise<SafwaDataExport> {
  return db.transaction(
    "r",
    [
      db.profile,
      db.settings,
      db.bookmarks,
      db.lists,
      db.sessions,
      db.studyComponents,
      db.studyAttempts,
      db.reviewEvents,
      db.mutationQueue,
      db.contentReleases,
      db.contentMetadata,
    ],
    async () => {
      const [
        profile,
        settings,
        bookmarks,
        lists,
        sessions,
        studyComponents,
        studyAttempts,
        reviewEvents,
        mutationQueue,
        activeMetadata,
      ] = await Promise.all([
        db.profile.get("device"),
        readOwnedRows(db.settings, owner),
        readOwnedRows(db.bookmarks, owner),
        readOwnedRows(db.lists, owner),
        db.sessions.toArray(),
        readOwnedRows(db.studyComponents, owner),
        db.studyAttempts
          .toArray()
          .then((rows) =>
            rows.filter((row) => (row.attempt?.userId ?? null) === owner),
          ),
        readOwnedRows(db.reviewEvents, owner),
        db.mutationQueue
          .toArray()
          .then((rows) => rows.filter((row) => (row.userId ?? null) === owner)),
        db.contentMetadata.get("active"),
      ]);
      const activeRelease = activeMetadata
        ? await db.contentReleases.get(activeMetadata.activeReleaseId)
        : undefined;
      return {
        export_schema_version: EXPORT_SCHEMA_VERSION,
        app: "safwa" as const,
        exported_at: new Date(now()).toISOString(),
        device_profile: profile ?? null,
        active_content: activeRelease
          ? {
              release_id: activeRelease.releaseId,
              content_version: activeRelease.contentVersion,
            }
          : null,
        settings,
        bookmarks,
        lists,
        sessions,
        study_components: studyComponents,
        study_attempts: studyAttempts,
        review_events: reviewEvents,
        mutation_queue: mutationQueue,
      };
    },
  );
}

export function serializeExport(payload: SafwaDataExport): string {
  return JSON.stringify(payload, null, 2);
}

/** safwa-export-YYYY-MM-DD.json (UTC date, matching exported_at). */
export function exportFilename(now: () => number = Date.now): string {
  const date = new Date(now()).toISOString().slice(0, 10);
  return `safwa-export-${date}.json`;
}

/** Trigger a client-side download of the serialised export. Browser-only. */
export function triggerJsonDownload(
  json: string,
  filename: string,
  doc: Document = document,
): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a later task: WebKit resolves blob URLs lazily, and revoking
  // synchronously after click() can abort the download with an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
