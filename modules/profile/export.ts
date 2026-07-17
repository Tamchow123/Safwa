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
  MutationQueueRecord,
  ReviewEventRecord,
  SafwaDb,
  SettingRecord,
  StudyAttemptRecord,
  StudyComponentRecord,
  StudySessionRecord,
} from "@/modules/content/db";

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
 * Snapshot all learner-state stores in one read transaction so the export
 * is internally consistent (no store read mid-write of another).
 */
export async function buildExportPayload(
  db: SafwaDb,
  now: () => number = Date.now,
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
        db.settings.toArray(),
        db.bookmarks.toArray(),
        db.lists.toArray(),
        db.sessions.toArray(),
        db.studyComponents.toArray(),
        db.studyAttempts.toArray(),
        db.reviewEvents.toArray(),
        db.mutationQueue.toArray(),
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
