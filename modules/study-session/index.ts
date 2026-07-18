/**
 * Study-session surface: the pure session plan builders (flashcards — Phase 8;
 * MC vocabulary quizzes — Phase 9; bāb/root quizzes and mixed revision —
 * Phase 10) built on the shared component-derivation choke points, plus the
 * impure Dexie persistence adapter that wires the pure engine + scheduler into
 * local learner-state. The planning helpers are pure; the persistence adapter
 * is browser-only (IndexedDB).
 */
export * from "@/modules/study-session/translation-components";
export * from "@/modules/study-session/flashcards";
export * from "@/modules/study-session/quizzes";
export * from "@/modules/study-session/entry-quizzes";
export * from "@/modules/study-session/mixed";
export * from "@/modules/study-session/persistence";
