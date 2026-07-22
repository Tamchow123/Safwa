/**
 * Phase 16 — natural-key / component / eligibility validation (§10 steps 3-10).
 *
 * PURE: given the reconstructed release context and a submitted item's
 * structured component fields + natural-key string, it validates that the key
 * is well-formed, matches the structured fields exactly (tamper detection), the
 * entry exists in the release, and the component is quiz-eligible. It reuses the
 * shared study engine's natural-key and eligibility logic — never a parallel
 * server implementation (§8.2). No server-only / DB imports.
 */
import type { LearnerEntry } from "@/modules/content/schema";
import type {
  ComponentShape,
  Direction,
  SkillType,
  SourceQuizFormField,
} from "@/modules/content/constants";
import {
  buildComponentKey,
  isComponentEligible,
  parseComponentKey,
  resolveComponentIdentity,
  type ResolvedComponentIdentity,
} from "@/modules/study-engine";
import type { QuestionContext } from "@/modules/study-engine/generator";
import type { SyncReasonCode } from "@/modules/sync/protocol";

/** The structured component fields submitted alongside the natural-key string. */
export type SubmittedComponent = {
  componentKey: string;
  entryId: number;
  skillType: SkillType;
  componentShape?: ComponentShape | null;
  sourceField?: SourceQuizFormField | null;
  direction?: Direction | null;
};

export type ComponentValidation =
  | {
      ok: true;
      identity: ResolvedComponentIdentity;
      componentKey: string;
      entry: LearnerEntry;
    }
  | {
      ok: false;
      reasonCode: Extract<
        SyncReasonCode,
        "natural_key_mismatch" | "ineligible_field" | "unknown_entry"
      >;
    };

/**
 * Validate a submitted component against the release. Order: resolve the
 * structured fields (structural validity), confirm the natural key matches the
 * canonical key those fields build AND round-trips through the parser (tamper),
 * confirm the entry exists, then confirm quiz eligibility.
 */
export function validateComponent(
  context: QuestionContext,
  submitted: SubmittedComponent,
): ComponentValidation {
  // 1. Resolve the structured fields — a structurally invalid combination
  //    (e.g. a form_direction skill missing its source field/direction) is a
  //    tampered key.
  let identity: ResolvedComponentIdentity;
  try {
    identity = resolveComponentIdentity({
      entryId: submitted.entryId,
      skillType: submitted.skillType,
      componentShape: submitted.componentShape,
      sourceField: submitted.sourceField,
      direction: submitted.direction,
    });
  } catch {
    return { ok: false, reasonCode: "natural_key_mismatch" };
  }

  // 2. The submitted natural key must equal the canonical key of those fields.
  const canonicalKey = buildComponentKey(identity);
  if (canonicalKey !== submitted.componentKey) {
    return { ok: false, reasonCode: "natural_key_mismatch" };
  }

  // 3. Defence in depth: the submitted key must itself parse to the same
  //    identity (rejects a key that is canonical-looking but internally
  //    inconsistent with the parser).
  try {
    const parsed = parseComponentKey(submitted.componentKey);
    if (buildComponentKey(parsed) !== canonicalKey) {
      return { ok: false, reasonCode: "natural_key_mismatch" };
    }
  } catch {
    return { ok: false, reasonCode: "natural_key_mismatch" };
  }

  // 4. The entry must exist in the referenced release.
  const entry = context.entriesById.get(identity.entryId);
  if (!entry) {
    return { ok: false, reasonCode: "unknown_entry" };
  }

  // 5. The component must be quiz-eligible (never teach an ineligible field —
  //    CLAUDE.md rule 2).
  if (!isComponentEligible(entry, identity)) {
    return { ok: false, reasonCode: "ineligible_field" };
  }

  return { ok: true, identity, componentKey: canonicalKey, entry };
}
