/**
 * Exact weak-set drill planning and URL request validation (Phase 13
 * §17-18) — the pure planner behind `/study/weak`.
 *
 * The drill practises the EXACT currently-qualifying weak set for one
 * dimension/value group, never a broad content filter that would
 * reintroduce strong or untouched components: every candidate is a
 * component `computeComponentWeakness` (Phase 13 T2) currently marks
 * `qualifiesAsWeak`, filtered to the requested group through the SAME
 * bāb/verb-type eligibility rules `modules/analytics/progress.ts` and
 * `modules/analytics/weakness-groups.ts` already use — never a second,
 * looser matching rule.
 *
 * The output is a plain `{ identity, promptForm? }[]`, structurally
 * identical to `components/study/quiz-runner.tsx`'s `QuizPlanEntry` — it
 * needs zero adaptation to be handed straight to the existing shared
 * `QuizRunner`. No new question engine, no natural-key change, no FSRS
 * change.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import type { SourceQuizFormField } from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import { babGroup, verbTypeGroup } from "@/modules/analytics/progress";
import type { ComponentWeakness } from "@/modules/analytics/weakness";
import type { WeaknessComponentEvidence } from "@/modules/analytics/weakness-evidence";
import {
  WEAKNESS_DIMENSIONS,
  type WeaknessDimension,
  type WeaknessGroup,
} from "@/modules/analytics/weakness-groups";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
import { isFieldEligible } from "@/modules/study-engine/fields";
import { defaultEntryPromptForm } from "@/modules/study-session/mixed";

/** One item of the exact-weak-set plan — matches `QuizPlanEntry` exactly. */
export type WeakDrillPlanEntry = {
  identity: ComponentIdentity;
  /** Present for entry-level items: the exact eligible prompt form to show. */
  promptForm?: SourceQuizFormField;
};

/** A validated weak-drill group request — never a raw component key. */
export type WeakDrillRequest = {
  dimension: WeaknessDimension;
  value: string;
};

/** Is this string one of the six recognised weakness dimensions? */
export function isWeaknessDimension(value: string): value is WeaknessDimension {
  return (WEAKNESS_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Validate a `/study/weak?dimension=...&value=...` request against the
 * CURRENT materialised group set (§17: "Unknown or invalid parameters must
 * show a safe not-found/invalid-set state"). A value that is not a real,
 * currently-surfaced group for that dimension is rejected — this also
 * naturally rejects a stale link to a group that has since resolved.
 */
export function validateWeakDrillRequest(
  dimensionParam: string | null | undefined,
  valueParam: string | null | undefined,
  groups: Readonly<Record<WeaknessDimension, readonly WeaknessGroup[]>>,
): WeakDrillRequest | null {
  if (!dimensionParam || !valueParam) return null;
  if (!isWeaknessDimension(dimensionParam)) return null;
  const exists = groups[dimensionParam].some((g) => g.value === valueParam);
  if (!exists) return null;
  return { dimension: dimensionParam, value: valueParam };
}

/** One candidate before final sort/slice. */
type WeakCandidate = {
  componentKey: string;
  identity: ComponentIdentity;
  promptForm?: SourceQuizFormField;
  score: number;
  lastAttemptAtMs: number | null;
};

/**
 * Does this component belong to the requested group, and — for an
 * entry-level component in a source-form-specific drill — which exact
 * prompt form does membership resolve to? Mirrors
 * `modules/analytics/weakness-groups.ts`'s own per-dimension matching so a
 * component can never be weak in one and absent from the other under the
 * same snapshot (§22).
 */
function resolveGroupMatch(
  request: WeakDrillRequest,
  entry: LearnerEntry,
  evidence: WeaknessComponentEvidence,
  weakness: ComponentWeakness,
): { matches: boolean; promptForm?: SourceQuizFormField } {
  switch (request.dimension) {
    case "bab":
      return { matches: babGroup(entry) === request.value };
    case "verb_type":
      return { matches: verbTypeGroup(entry) === request.value };
    case "direction":
      return { matches: evidence.direction === request.value };
    case "skill":
      return { matches: evidence.skillType === request.value };
    case "state":
      return { matches: evidence.effectiveState === request.value };
    case "source_form": {
      if (evidence.sourceField !== null) {
        // A translation component's form is intrinsic to its identity.
        return { matches: evidence.sourceField === request.value };
      }
      // Entry-level: only the SAME windowed evidence the score was computed
      // from (never the unbounded lifetime history — §12.3/ARCH-001) may
      // select this form, and the form must still be quiz-eligible NOW.
      const form = request.value as SourceQuizFormField;
      const hasFormEvidence = weakness.consideredFirstAttempts.some(
        (row) => row.analysisForm === form,
      );
      if (!hasFormEvidence || !isFieldEligible(entry, form)) {
        return { matches: false };
      }
      return { matches: true, promptForm: form };
    }
  }
}

/**
 * Build the exact weak-set drill plan for one validated group request.
 * Deterministic in its inputs: `seed` is accepted for signature parity with
 * every other session planner (`buildMixedPlan`, `buildCustomPlan`) and for
 * a future secondary shuffle, but the current ordering — weakest first,
 * most-recently-attempted first, then stable component-key order — is
 * already fully deterministic without needing it.
 */
export function buildWeakDrillPlan(
  entries: readonly LearnerEntry[],
  weaknessEvidence: ReadonlyMap<string, WeaknessComponentEvidence>,
  componentWeakness: ReadonlyMap<string, ComponentWeakness>,
  request: WeakDrillRequest,
  sessionDefaults: { questionCount: number },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature parity, see doc comment
  seed: string,
): WeakDrillPlanEntry[] {
  if (
    !Number.isInteger(sessionDefaults.questionCount) ||
    sessionDefaults.questionCount < 1
  ) {
    throw new Error(
      `weak drill question count must be a positive integer, got ${sessionDefaults.questionCount}`,
    );
  }

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const candidates: WeakCandidate[] = [];

  for (const [componentKey, weakness] of componentWeakness) {
    // Only components CURRENTLY qualifying as weak — never a broader
    // content filter that would reintroduce strong or untouched material.
    if (!weakness.qualifiesAsWeak) continue;

    const evidence = weaknessEvidence.get(componentKey);
    if (!evidence) continue; // stale/ineligible — excluded, never planned
    const entry = entriesById.get(evidence.entryId);
    if (!entry) continue; // entry not in the current release

    const match = resolveGroupMatch(request, entry, evidence, weakness);
    if (!match.matches) continue;

    let promptForm = match.promptForm;
    if (promptForm === undefined && evidence.sourceField === null) {
      // A non-form-specific drill of an entry-level component: the SAME
      // deterministic eligible prompt-form policy every other planner
      // uses (never the component identity, never a hand-picked default).
      const resolved = defaultEntryPromptForm(entry);
      if (resolved === null) continue; // cannot be presented as a question
      promptForm = resolved;
    }

    const identity: ComponentIdentity =
      evidence.sourceField !== null
        ? {
            entryId: evidence.entryId,
            skillType: evidence.skillType,
            sourceField: evidence.sourceField,
            direction: evidence.direction!,
          }
        : { entryId: evidence.entryId, skillType: evidence.skillType };

    candidates.push({
      componentKey,
      identity,
      promptForm,
      score: weakness.score,
      lastAttemptAtMs: weakness.lastAttemptAtMs,
    });
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (b.lastAttemptAtMs ?? -Infinity) - (a.lastAttemptAtMs ?? -Infinity) ||
      a.componentKey.localeCompare(b.componentKey, "en"),
  );

  return candidates
    .slice(0, sessionDefaults.questionCount)
    .map(({ identity, promptForm }) => ({ identity, promptForm }));
}
