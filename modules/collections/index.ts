/**
 * Collections module barrel (Phase 14 — bookmarks & custom lists). Re-exports
 * the pure record/validation API and the Dexie persistence adapter; the pure
 * session-filter helpers are added alongside this file as later Phase 14
 * slices land.
 */
export * from "@/modules/collections/validation";
export * from "@/modules/collections/bookmarks";
export * from "@/modules/collections/lists";
export * from "@/modules/collections/persistence";
