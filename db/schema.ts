/**
 * Barrel re-exporting every migration-0001 table/relation. Used by
 * drizzle.config.ts (schema discovery) and db/client.ts (the Drizzle
 * instance's typed schema).
 */
export * from "@/db/schema/auth";
export * from "@/db/schema/learning";
export * from "@/db/schema/collections";
export * from "@/db/schema/settings";
export * from "@/db/schema/content";
