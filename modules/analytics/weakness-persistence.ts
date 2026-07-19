/**
 * Weakness persistence adapter (impure, BROWSER-ONLY) — the thin Dexie
 * wiring between the pure weakness modules (T1-T3) and the local learner
 * stores (Phase 13 §7, §30). Mirrors modules/analytics/persistence.ts: the
 * pure modules never import Dexie; this is the ONE place weakness analytics
 * are assembled end to end.
 *
 * REUSE, NOT A THIRD READER: this calls `readAnalyticsRawSnapshot` — the
 * SAME raw component/attempt/event read the dashboard/progress pages'
 * `readAnalyticsSnapshot` is built on — never a second/third independent
 * `study_attempts`/`review_events` scan implementation (that would risk Weak
 * Areas disagreeing with Dashboard/Progress about which rows are valid).
 * Deliberately the READ-ONLY variant: weakness analytics never reads
 * `dailyActivity`, so it must not pay for (or trigger) that cache's
 * clear+rewrite write on every call — this runs on the mixed/custom
 * session-start hot path, not just the dashboard, so an unconditional write
 * there would add IndexedDB traffic to the app's busiest entry points for a
 * result this module never consumes.
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
import { readAnalyticsRawSnapshot } from "@/modules/analytics/persistence";
import {
  computeAllComponentWeakness,
  qualifyingWeaknessScore,
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

/** The shared read-and-score step both exports below build on. */
async function readComponentWeakness(
  db: SafwaDb,
  derived: readonly DerivedComponent[],
  nowMs: number,
): Promise<{
  weaknessEvidence: ReadonlyMap<string, WeaknessComponentEvidence>;
  componentWeakness: ReadonlyMap<string, ComponentWeakness>;
}> {
  const persisted = await readAnalyticsRawSnapshot(db);
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
  return { weaknessEvidence, componentWeakness };
}

/**
 * Read one consistent snapshot and compute the complete weakness view: the
 * §7-9 evidence, the §10 per-component scores, and the §12-14 ranked groups
 * for all six dimensions plus a merged top-N overall list. `derived` is the
 * caller's memoised `deriveAllComponents(entries)` output — passed in
 * rather than recomputed here, so repeated calls (retry, visibility
 * refresh) never repeat that derivation pass. Used by the Weak Areas page.
 */
export async function loadWeaknessView(
  db: SafwaDb,
  derived: readonly DerivedComponent[],
  entries: readonly LearnerEntry[],
  nowMs: number,
): Promise<WeaknessView> {
  const { weaknessEvidence, componentWeakness } = await readComponentWeakness(
    db,
    derived,
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

/**
 * Read weakness evidence and compute per-component SCORES only, adapted for
 * scheduling consumption via `qualifyingWeaknessScore` — skips the §12-14
 * group aggregation (`buildAllWeaknessGroups`/`topOverallWeaknessGroups`),
 * which only the Weak Areas page needs. The mixed-revision weak tier
 * (`components/study/mixed-session.tsx`) and the Custom Session weak filter
 * (`components/study/custom-session.tsx`) both call this ONE helper rather
 * than each re-deriving the same "load view, adapt every score" sequence,
 * so they can never independently drift (§22 agreement) and never pay for
 * group ranking work they do not use.
 */
export async function loadWeakScores(
  db: SafwaDb,
  derived: readonly DerivedComponent[],
  nowMs: number,
): Promise<ReadonlyMap<string, number>> {
  const { componentWeakness } = await readComponentWeakness(db, derived, nowMs);
  const scores = new Map<string, number>();
  for (const [key, cw] of componentWeakness) {
    scores.set(key, qualifyingWeaknessScore(cw));
  }
  return scores;
}

/**
 * Read weakness evidence and per-component scores WITHOUT the §12-14 group
 * aggregation — for the weak-drill session's `buildPlan` (§17-19), which
 * needs `buildWeakDrillPlan`'s exact `weaknessEvidence`/`componentWeakness`
 * inputs on every fresh session mount (including "Study again", so a
 * component that is no longer weak is excluded from the rebuilt plan) but
 * never the ranked-group output the Weak Areas page needs. Same shared
 * read-and-score step as `loadWeaknessView`/`loadWeakScores` — never a
 * fourth independent implementation.
 */
export async function loadWeaknessEvidence(
  db: SafwaDb,
  derived: readonly DerivedComponent[],
  nowMs: number,
): Promise<{
  weaknessEvidence: ReadonlyMap<string, WeaknessComponentEvidence>;
  componentWeakness: ReadonlyMap<string, ComponentWeakness>;
}> {
  return readComponentWeakness(db, derived, nowMs);
}
