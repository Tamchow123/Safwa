/**
 * Public barrel for the PURE analytics modules. The browser-only Dexie
 * adapter is deliberately NOT re-exported here — import it directly from
 * `@/modules/analytics/persistence` (as study-session consumers import their
 * persistence adapter directly) so pure contexts can consume this barrel
 * without pulling Dexie.
 */
export * from "@/modules/analytics/dates";
export * from "@/modules/analytics/activity";
export * from "@/modules/analytics/streaks";
export * from "@/modules/analytics/progress";
