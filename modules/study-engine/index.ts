/**
 * Public surface of the pure-TypeScript study engine (Phase 6).
 *
 * Everything here runs identically in the browser and (later) on the server:
 * component derivation, the shared natural-key builder, deterministic question
 * generation, distractor selection, the session state machine, attempt-record
 * creation and shared correctness logic. No React, DOM or DB imports.
 */
export * from "@/modules/study-engine/natural-key";
export * from "@/modules/study-engine/rng";
export * from "@/modules/study-engine/fields";
export * from "@/modules/study-engine/components";
export * from "@/modules/study-engine/distractors";
export * from "@/modules/study-engine/generator";
export * from "@/modules/study-engine/hints";
export * from "@/modules/study-engine/correctness";
export * from "@/modules/study-engine/attempts";
export * from "@/modules/study-engine/session";
