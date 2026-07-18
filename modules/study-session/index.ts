/**
 * Study-session surface (Phase 8): the pure flashcard plan builder and the
 * impure Dexie persistence adapter that wires the pure engine + scheduler into
 * local learner-state. The planning helpers are pure; the persistence adapter
 * is browser-only (IndexedDB).
 */
export * from "@/modules/study-session/flashcards";
export * from "@/modules/study-session/persistence";
