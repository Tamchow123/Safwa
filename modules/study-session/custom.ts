/**
 * Custom session configuration (pure) — the full §4.4 filter matrix
 * (PRODUCT_REQUIREMENTS.md §4.4, Phase 11), extended with the Phase 14 §19
 * bookmark/custom-list collection axis.
 *
 * A custom session composes: mode (flashcards / MC translation / bāb / root);
 * direction; specific form(s) or any eligible; bāb; verb category; book page
 * range; component state (new / learning / mastered / weak / due); the
 * bookmark/list collection axis (§19); question count; timed; test mode.
 *
 * Candidates come exclusively from the shared derivation choke point
 * (`deriveAllComponents`), which yields a component only when every field it
 * depends on is quiz-eligible — so an ineligible field can NEVER become a
 * prompt, answer or distractor (CLAUDE.md hard rule 2). This module only
 * FILTERS that already-gated set; it never re-derives eligibility itself.
 * The collection axis is exactly the same kind of narrowing filter as bāb or
 * verb type — it never creates a component (§19: "Collection membership
 * narrows an already valid component universe; it never creates a
 * component"). A verb-type filter additionally requires
 * `quiz_eligibility.verb_type`, so the two unresolved entries (369/372)
 * never match a verb-type selection — their unverified classification must
 * not even be used to SELECT them.
 *
 * The `membership` parameter threaded through every function below is
 * OPTIONAL and defaults to `EMPTY_COLLECTION_MEMBERSHIP`: with the default
 * neutral `collections` filter (`OPEN_COLLECTION_FILTER`, no selection) the
 * collection axis is unrestricted regardless of membership content, so
 * existing callers that do not yet pass a real snapshot are unaffected.
 *
 * The plan is a pure function of (entries, config, stored state, weak scores,
 * seed, now, membership) with an injected RNG seed and clock instant, so a
 * session plan is reproducible and never calls Math.random/Date.now.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import {
  SOURCE_QUIZ_FORM_FIELDS,
  type BabId,
  type SourceQuizFormField,
  type VerbTypeId,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";

import {
  EMPTY_COLLECTION_MEMBERSHIP,
  hasCollectionSelection,
  matchesCollectionFilter,
  OPEN_COLLECTION_FILTER,
  type CollectionFilter,
  type CollectionMembership,
} from "@/modules/collections/filters";
import { isDue } from "@/modules/scheduler/fsrs";
import {
  effectiveLearnerState,
  isUsableCard,
} from "@/modules/scheduler/states";
import {
  deriveAllComponents,
  type DerivedComponent,
} from "@/modules/study-engine/components";
import { isFieldEligible } from "@/modules/study-engine/fields";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
import { createRng, type Rng } from "@/modules/study-engine/rng";
import type { TranslationDirectionChoice } from "@/modules/study-session/translation-components";
import type { StoredComponentState } from "@/modules/study-session/mixed";

/** The §4.3 learning modes a custom session can launch (Phase-11 set). */
export const CUSTOM_SESSION_MODES = [
  "flashcards",
  "mc",
  "bab",
  "root",
] as const;
export type CustomSessionMode = (typeof CUSTOM_SESSION_MODES)[number];

/** Component-state filters (§4.4: new / learning / mastered / weak / due). */
export const COMPONENT_STATE_FILTERS = [
  "new",
  "learning",
  "mastered",
  "weak",
  "due",
] as const;
export type ComponentStateFilter = (typeof COMPONENT_STATE_FILTERS)[number];

/** An inclusive book-page range; null bounds are open ends. */
export type BookPageRange = {
  min: number | null;
  max: number | null;
};

/**
 * The §4.4 content filters. Every multi-select is UNION-within-the-axis and
 * INTERSECTION-across-axes: an EMPTY selection means "any" for that axis.
 */
export type CustomSessionFilters = {
  mode: CustomSessionMode;
  /** Translation modes only (ignored for bāb/root). */
  direction: TranslationDirectionChoice;
  /**
   * Source form(s). Translation modes: the quizzed form must be one of these.
   * Bāb/root modes: the PROMPT form is drawn from these (eligible ones only).
   * Empty = any eligible form.
   */
  forms: readonly SourceQuizFormField[];
  /** Bāb filter (empty = any). */
  babs: readonly BabId[];
  /** Verb category filter (empty = any; unverified entries never match). */
  verbTypes: readonly VerbTypeId[];
  /** Book page / source grouping (open range = any). */
  bookPages: BookPageRange;
  /** Component-state filter (empty = any state). */
  states: readonly ComponentStateFilter[];
  /** Bookmark/custom-list collection axis (§19; no selection = any). */
  collections: CollectionFilter;
};

/** A full custom session configuration (filters + session shape). */
export type CustomSessionConfig = CustomSessionFilters & {
  count: number;
  timed: boolean;
  /** Per-question limit in ms (timed only; §4.4 default 20s). */
  perQuestionLimitMs: number;
  testMode: boolean;
};

/** The neutral starting filters: everything open, nothing excluded. */
export const OPEN_CUSTOM_FILTERS: CustomSessionFilters = {
  mode: "mc",
  direction: "random",
  forms: [],
  babs: [],
  verbTypes: [],
  bookPages: { min: null, max: null },
  states: [],
  collections: OPEN_COLLECTION_FILTER,
};

/* ------------------------------------------------------------------ */
/* Entry-axis matching                                                 */
/* ------------------------------------------------------------------ */

function matchesBab(entry: LearnerEntry, babs: readonly BabId[]): boolean {
  if (babs.length === 0) return true;
  // Bāb classification is quiz-eligible for every entry, but the gate is
  // still checked: an ineligible classification must never SELECT an entry.
  return isFieldEligible(entry, "bab") && babs.includes(entry.bab);
}

function matchesVerbType(
  entry: LearnerEntry,
  verbTypes: readonly VerbTypeId[],
): boolean {
  if (verbTypes.length === 0) return true;
  // An unverified verb type (entries 369/372) never matches a specific
  // selection — using the unverified value to select would teach it.
  return (
    isFieldEligible(entry, "verb_type") && verbTypes.includes(entry.verb_type)
  );
}

function matchesBookPage(entry: LearnerEntry, range: BookPageRange): boolean {
  if (range.min !== null && entry.book_page < range.min) return false;
  if (range.max !== null && entry.book_page > range.max) return false;
  return true;
}

/**
 * Does an entry pass every ENTRY-axis filter (bāb, verb type, page,
 * collections)? `membership` defaults to empty — safe because the default
 * `collections` filter (`OPEN_COLLECTION_FILTER`) is unselected, so the
 * collection check is a no-op unless a caller supplies both a real
 * selection and its matching membership snapshot.
 */
export function matchesEntryFilters(
  entry: LearnerEntry,
  filters: CustomSessionFilters,
  membership: CollectionMembership = EMPTY_COLLECTION_MEMBERSHIP,
): boolean {
  return (
    matchesBab(entry, filters.babs) &&
    matchesVerbType(entry, filters.verbTypes) &&
    matchesBookPage(entry, filters.bookPages) &&
    matchesCollectionFilter(entry.id, filters.collections, membership)
  );
}

/* ------------------------------------------------------------------ */
/* Component-axis matching                                             */
/* ------------------------------------------------------------------ */

/** The prompt forms allowed for an entry-level item under the form filter. */
export function allowedPromptForms(
  entry: LearnerEntry,
  forms: readonly SourceQuizFormField[],
): SourceQuizFormField[] {
  const pool = forms.length === 0 ? SOURCE_QUIZ_FORM_FIELDS : forms;
  return pool.filter((field) => isFieldEligible(entry, field));
}

function matchesMode(
  component: DerivedComponent,
  filters: CustomSessionFilters,
  entry: LearnerEntry,
): boolean {
  switch (filters.mode) {
    case "flashcards":
    case "mc":
      if (component.componentShape !== "form_direction") return false;
      if (
        filters.direction !== "random" &&
        component.direction !== filters.direction
      ) {
        return false;
      }
      return (
        filters.forms.length === 0 ||
        filters.forms.includes(component.sourceField!)
      );
    case "bab":
      return (
        component.skillType === "bab_identification" &&
        allowedPromptForms(entry, filters.forms).length > 0
      );
    case "root":
      return (
        component.skillType === "root_identification" &&
        allowedPromptForms(entry, filters.forms).length > 0
      );
  }
}

/**
 * Every derived (hence eligible) component matching the CONTENT filters —
 * mode/direction/forms plus the entry axes — in stable derivation order.
 * State filtering is a separate step (`filterByStates`) because it needs the
 * stored scheduling snapshot.
 */
export function eligibleCustomComponents(
  entries: readonly LearnerEntry[],
  filters: CustomSessionFilters,
  membership: CollectionMembership = EMPTY_COLLECTION_MEMBERSHIP,
): DerivedComponent[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  return deriveAllComponents(entries).filter((component) => {
    const entry = entriesById.get(component.entryId)!;
    return (
      matchesEntryFilters(entry, filters, membership) &&
      matchesMode(component, filters, entry)
    );
  });
}

/* ------------------------------------------------------------------ */
/* State filtering                                                     */
/* ------------------------------------------------------------------ */

/**
 * The state-filter classes one component currently belongs to. Classes are
 * NOT exclusive (a due card may also be weak); the filter is satisfied when
 * ANY selected class matches (union semantics, like every other axis):
 *
 *  - `new`      — never reviewed (no stored FSRS card);
 *  - `learning` — effective learner state `learning`;
 *  - `mastered` — effective learner state `mastered`;
 *  - `weak`     — weakness EVIDENCE: a positive weak score (Phase 13 v2,
 *                 `modules/analytics/weakness.ts` adapted via
 *                 `qualifyingWeaknessScore` — already zero without genuine
 *                 failure/lapse evidence) and not mastered (mirrors the
 *                 scheduler's weak-tier rule). A `needs_review` effective
 *                 state alone is deliberately NOT a second trigger: an
 *                 ordinary due mastered card with a clean history must not
 *                 be falsely called weak;
 *  - `due`      — the stored card is due at the injected instant.
 *
 * The stored learner-state projection is only refreshed when an event is
 * written, so it can be STALE relative to the clock: a card stored as
 * `mastered` whose due date has since passed (or that lapsed into
 * relearning) is `needs_review` NOW (§5 "due/lapsed after mastery"). The
 * EFFECTIVE state is therefore re-derived against the injected instant
 * through the ONE shared helper (`effectiveLearnerState`) that dashboard
 * and progress analytics also use — a due or lapsed card is never
 * classified mastered.
 */
export function componentStateClasses(
  stored: StoredComponentState | undefined,
  weakScore: number,
  nowMs: number,
): ComponentStateFilter[] {
  const classes: ComponentStateFilter[] = [];
  const card = stored?.fsrs ?? null;
  if (card === null) {
    classes.push("new");
    return classes;
  }
  // A structurally corrupt stored card matches NO state class — not even
  // "new" (a card row exists; it just cannot be trusted). Corrupt data must
  // never satisfy an explicit state selection, including "due".
  if (!isUsableCard(card)) return classes;
  const state = effectiveLearnerState(stored?.learnerState, card, nowMs);
  if (state === "learning") classes.push("learning");
  if (state === "mastered") classes.push("mastered");
  if (state !== "mastered" && weakScore > 0) {
    classes.push("weak");
  }
  // effectiveLearnerState re-checks due-ness internally for the mastered
  // case; this second isDue call is INTENTIONAL — the shared helper stays
  // self-contained for its other consumers, and the cost is one comparison.
  if (isDue(card, nowMs)) classes.push("due");
  return classes;
}

/** Keep the components matching the state filter (empty filter = keep all). */
export function filterByStates(
  components: readonly DerivedComponent[],
  states: readonly ComponentStateFilter[],
  stored: ReadonlyMap<string, StoredComponentState>,
  weakScores: ReadonlyMap<string, number>,
  nowMs: number,
): DerivedComponent[] {
  if (states.length === 0) return [...components];
  return components.filter((component) => {
    const classes = componentStateClasses(
      stored.get(component.key),
      weakScores.get(component.key) ?? 0,
      nowMs,
    );
    return classes.some((cls) => states.includes(cls));
  });
}

/* ------------------------------------------------------------------ */
/* Plan building                                                       */
/* ------------------------------------------------------------------ */

/** A planned custom-session item for `createSession`. */
export type CustomPlanItem = {
  identity: ComponentIdentity;
  /** Present for entry-level items: the resolved, eligible prompt form. */
  promptForm?: SourceQuizFormField;
};

function resolvePromptForm(
  entry: LearnerEntry,
  forms: readonly SourceQuizFormField[],
  rng: Rng,
): SourceQuizFormField {
  const allowed = allowedPromptForms(entry, forms);
  // eligibleCustomComponents already excluded zero-form entries.
  return allowed.length === 1 ? allowed[0] : allowed[rng.int(allowed.length)];
}

/**
 * Build a deterministic custom-session plan: content-filter, state-filter,
 * shuffle with the injected seed, take up to `count`, and resolve entry-level
 * prompt forms (seeded-random among the entry's ALLOWED eligible forms). An
 * empty result is a valid outcome the caller handles with the empty-result
 * guard (`looseningSuggestions`), never an error.
 */
export function buildCustomPlan(
  entries: readonly LearnerEntry[],
  config: CustomSessionConfig,
  stored: ReadonlyMap<string, StoredComponentState>,
  weakScores: ReadonlyMap<string, number>,
  seed: string,
  nowMs: number,
  membership: CollectionMembership = EMPTY_COLLECTION_MEMBERSHIP,
): CustomPlanItem[] {
  if (!Number.isInteger(config.count) || config.count < 1) {
    throw new Error(
      `custom session count must be a positive integer, got ${config.count}`,
    );
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const matching = filterByStates(
    eligibleCustomComponents(entries, config, membership),
    config.states,
    stored,
    weakScores,
    nowMs,
  );
  const rng = createRng(seed);
  return rng
    .shuffle(matching)
    .slice(0, config.count)
    .map((component) => {
      if (component.componentShape === "entry_level") {
        return {
          identity: {
            entryId: component.entryId,
            skillType: component.skillType,
          },
          promptForm: resolvePromptForm(
            entriesById.get(component.entryId)!,
            config.forms,
            rng,
          ),
        };
      }
      return {
        identity: {
          entryId: component.entryId,
          skillType: component.skillType,
          sourceField: component.sourceField,
          direction: component.direction,
        },
      };
    });
}

/* ------------------------------------------------------------------ */
/* Empty-result guard                                                  */
/* ------------------------------------------------------------------ */

/** One actionable loosening suggestion for an empty filter result. */
export type LooseningSuggestion = {
  /** The filter axis whose relaxation makes the result non-empty. */
  axis:
    | "forms"
    | "babs"
    | "verbTypes"
    | "bookPages"
    | "states"
    | "direction"
    | "collections";
  /** Learner-facing suggestion text. */
  label: string;
};

const AXIS_RELAXATIONS: {
  axis: LooseningSuggestion["axis"];
  isActive: (filters: CustomSessionFilters) => boolean;
  relax: (filters: CustomSessionFilters) => CustomSessionFilters;
  label: string;
}[] = [
  {
    axis: "states",
    isActive: (filters) => filters.states.length > 0,
    relax: (filters) => ({ ...filters, states: [] }),
    label: "Include every progress state",
  },
  {
    axis: "forms",
    isActive: (filters) => filters.forms.length > 0,
    relax: (filters) => ({ ...filters, forms: [] }),
    label: "Allow any eligible form",
  },
  {
    axis: "babs",
    isActive: (filters) => filters.babs.length > 0,
    relax: (filters) => ({ ...filters, babs: [] }),
    label: "Remove the bāb filter",
  },
  {
    axis: "verbTypes",
    isActive: (filters) => filters.verbTypes.length > 0,
    relax: (filters) => ({ ...filters, verbTypes: [] }),
    label: "Remove the verb-type filter",
  },
  {
    axis: "bookPages",
    isActive: (filters) =>
      filters.bookPages.min !== null || filters.bookPages.max !== null,
    relax: (filters) => ({ ...filters, bookPages: { min: null, max: null } }),
    label: "Widen the book-page range",
  },
  {
    axis: "direction",
    isActive: (filters) =>
      (filters.mode === "mc" || filters.mode === "flashcards") &&
      filters.direction !== "random",
    relax: (filters) => ({ ...filters, direction: "random" }),
    label: "Allow both directions",
  },
  {
    axis: "collections",
    isActive: (filters) => hasCollectionSelection(filters.collections),
    relax: (filters) => ({ ...filters, collections: OPEN_COLLECTION_FILTER }),
    label: "Include vocabulary outside your bookmarks and lists",
  },
];

/**
 * Which single-axis relaxations would make an EMPTY result non-empty (§4.4
 * empty-result guard: "suggests loosening filters"). Each active axis is
 * relaxed alone against the same stored state; an axis whose relaxation still
 * yields nothing is not suggested. When no single axis rescues the result,
 * every active axis is suggested (loosening several at once is the only way
 * out, so all of them are actionable).
 */
export function looseningSuggestions(
  entries: readonly LearnerEntry[],
  filters: CustomSessionFilters,
  states: {
    stored: ReadonlyMap<string, StoredComponentState>;
    weakScores: ReadonlyMap<string, number>;
    nowMs: number;
  },
  membership: CollectionMembership = EMPTY_COLLECTION_MEMBERSHIP,
): LooseningSuggestion[] {
  const active = AXIS_RELAXATIONS.filter((axis) => axis.isActive(filters));
  const rescues = active.filter((axis) => {
    const relaxed = axis.relax(filters);
    const matching = filterByStates(
      eligibleCustomComponents(entries, relaxed, membership),
      relaxed.states,
      states.stored,
      states.weakScores,
      states.nowMs,
    );
    return matching.length > 0;
  });
  const chosen = rescues.length > 0 ? rescues : active;
  return chosen.map((axis) => ({ axis: axis.axis, label: axis.label }));
}
