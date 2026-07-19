/**
 * Weakness persistence adapter (impure, BROWSER-ONLY) — the thin Dexie
 * wiring between the pure weakness modules (T1-T3) and the local learner
 * stores (Phase 13 §7, §30). Mirrors modules/analytics/persistence.ts: the
 * pure modules never import Dexie; this is the ONE place weakness analytics
 * are assembled end to end.
 *
 * REUSE, NOT A THIRD READER: this calls the SAME `readAnalyticsSnapshot`
 * the dashboard/progress pages already use — never a second/third
 * independent `study_attempts`/`review_events` scan (that would risk Weak
 * Areas disagreeing with Dashboard/Progress about which rows are valid).
 * The component universe is joined once (`effectiveComponents`) per call,
 * exactly like the Phase 12 analytics load — the CALLER derives it once per
 * loaded release (`deriveAllComponents`, e.g. `useWeaknessSnapshot`'s
 * `useMemo`, mirroring `use-analytics-snapshot.ts`) and passes the result
 * in, so a visibility-refresh/retry never repeats that derivation pass.
 *
 * The clock instant is INJECTED by the caller — this adapter never invents
 * time.
 */
import type { SafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { effectiveComponents } from "@/modules/analytics/progress";
import { readAnalyticsSnapshot } from "@/modules/analytics/persistence";
import {
  computeAllComponentWeakness,
  type ComponentWeakness,
} from "@/modules/analytics/weakness";
import {
  prepareWeaknessEvidence,
  type WeaknessComponentEvidence,
} from "@/modules/analytics/weakness-evidence";
import {
  buildAllWeaknessGroups,
  topOverallWeaknessGroups,
  type WeaknessDimension,
  type WeaknessGroup,
} from "@/modules/analytics/weakness-groups";
import type { DerivedComponent } from "@/modules/study-engine/components";

/** The one finished weakness view every Phase 13 UI consumer reads. */
export type WeaknessView = {
  componentWeakness: ReadonlyMap<string, ComponentWeakness>;
  weaknessEvidence: ReadonlyMap<string, WeaknessComponentEvidence>;
  groups: Record<WeaknessDimension, WeaknessGroup[]>;
  topOverall: WeaknessGroup[];
};

const TOP_OVERALL_LIMIT = 5;

/**
 * Read one consistent snapshot and compute the complete weakness view: the
 * §7-9 evidence, the §10 per-component scores, and the §12-14 ranked groups
 * for all six dimensions plus a merged top-N overall list. `derived` is the
 * caller's memoised `deriveAllComponents(entries)` output — passed in
 * rather than recomputed here, so repeated calls (retry, visibility
 * refresh) never repeat that derivation pass.
 */
export async function loadWeaknessView(
  db: SafwaDb,
  derived: readonly DerivedComponent[],
  entries: readonly LearnerEntry[],
  nowMs: number,
): Promise<WeaknessView> {
  const persisted = await readAnalyticsSnapshot(db, nowMs);
  const effective = effectiveComponents(derived, persisted.components, nowMs);

  const weaknessEvidence = prepareWeaknessEvidence(
    effective,
    persisted.attempts,
    persisted.events,
  );
  const componentWeakness = computeAllComponentWeakness(
    weaknessEvidence,
    nowMs,
  );
  const groups = buildAllWeaknessGroups(
    componentWeakness,
    weaknessEvidence,
    entries,
  );
  const topOverall = topOverallWeaknessGroups(groups, TOP_OVERALL_LIMIT);

  return { componentWeakness, weaknessEvidence, groups, topOverall };
}
