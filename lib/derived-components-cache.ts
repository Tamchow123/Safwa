/**
 * A single-entry cache over `deriveAllComponents`, keyed by referential
 * equality of the `entries` array (Phase 13 §15 — the Progress page is the
 * first page to mount two independent snapshot hooks over the same loaded
 * release, `useAnalyticsSnapshot` and `useWeaknessSnapshot`; without this,
 * both would redundantly re-run the full derivation pass). `entries` arrays
 * are stable per content load (never mutated in place), so reference
 * equality is a safe and sufficient cache key — this is a pure memoization,
 * never a source of staleness: a genuinely new `entries` array (a fresh
 * content load) always recomputes.
 *
 * Not a `modules/*` export deliberately: `modules/study-engine/components.ts`
 * is a pure, side-effect-free module exercised directly by its own unit
 * tests, and this mutable cache belongs in the impure UI layer instead.
 */
import type { LearnerEntry } from "@/modules/content/schema";
import {
  deriveAllComponents,
  type DerivedComponent,
} from "@/modules/study-engine/components";

let cache: {
  entries: readonly LearnerEntry[];
  derived: DerivedComponent[];
} | null = null;

export function deriveAllComponentsCached(
  entries: readonly LearnerEntry[],
): DerivedComponent[] {
  if (cache && cache.entries === entries) return cache.derived;
  const derived = deriveAllComponents(entries);
  cache = { entries, derived };
  return derived;
}
