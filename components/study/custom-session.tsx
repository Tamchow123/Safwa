"use client";

/**
 * Custom session configuration (Phase 11, extended by Phase 14 §19) — the
 * full §4.4 filter matrix on one setup screen: mode, direction, form(s), bāb,
 * verb type, book page range, state filters, the bookmark/custom-list
 * collection axis, question count, timed and test mode.
 *
 * Bāb and verb-type choices display their Arabic pairs read from the loaded
 * release (never numbering, never hand-typed Arabic — hard rules 3/5). The
 * matching component set comes from the pure `modules/study-session/custom`
 * filter engine; an empty result (including an explicitly selected empty
 * collection) renders the loosening-suggestions guard instead of a session
 * (§4.4 empty-result guard). Bookmarks/lists are re-read directly from Dexie
 * at every Start — including Study Again — never from the setup screen's
 * live `useCollections()` snapshot, so a list edit made mid-session always
 * affects the next plan (§19 "Study Again").
 *
 * Direct study URL presets (§20/§21): `?collection=bookmarks` and
 * `?list=<id>` seed the INITIAL collection selection only (never
 * auto-start), read once from the URL that was present at mount so a reload
 * reproduces the same preset. Later in-page filter edits are local
 * component state and are never written back to the URL.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArabicText } from "@/components/arabic-text";
import { useCollections } from "@/components/collections/use-collections";
import { useActiveContent } from "@/components/content/use-active-content";
import {
  FlashcardRunner,
  type FlashcardPlanBuilder,
} from "@/components/study/flashcard-session";
import {
  ContentStateFallback,
  QuizRunner,
  type QuizPlanBuilder,
} from "@/components/study/quiz-runner";
import { FIELD_LABELS } from "@/components/study/study-shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import { loadWeakScores } from "@/modules/analytics/weakness-persistence";
import type { CollectionMembership } from "@/modules/collections/filters";
import { readCollectionMembership } from "@/modules/collections/persistence";
import { getSafwaDb } from "@/modules/content/db";
import { readEffectiveClock } from "@/modules/profile/timezone";
import {
  BAB_IDS,
  SOURCE_QUIZ_FORM_FIELDS,
  VERB_TYPE_IDS,
  type BabId,
  type VerbTypeId,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import type { AttemptClock } from "@/modules/study-engine/attempts";
import { deriveAllComponents } from "@/modules/study-engine/components";
import { DEFAULT_TIMED_LIMIT_MS } from "@/modules/study-engine/session";
import {
  buildCustomPlan,
  COMPONENT_STATE_FILTERS,
  eligibleCustomComponents,
  filterByStates,
  looseningSuggestions,
  OPEN_CUSTOM_FILTERS,
  type ComponentStateFilter,
  type CustomSessionConfig,
  type CustomSessionFilters,
  type CustomSessionMode,
  type LooseningSuggestion,
} from "@/modules/study-session/custom";
import { parseCollectionPreset } from "@/modules/study-session/custom-session-url";
import type { StoredComponentState } from "@/modules/study-session/mixed";
import { readSchedulingSnapshot } from "@/modules/study-session/persistence";
import type { QuizDelivery } from "@/modules/study-session/quizzes";
import type { TranslationDirectionChoice } from "@/modules/study-session/translation-components";

const MODE_OPTIONS: { value: CustomSessionMode; label: string }[] = [
  { value: "mc", label: "Multiple choice" },
  { value: "flashcards", label: "Flashcards" },
  { value: "bab", label: "Bāb quiz" },
  { value: "root", label: "Root quiz" },
];

const DIRECTION_OPTIONS: {
  value: TranslationDirectionChoice;
  label: string;
}[] = [
  { value: "random", label: "Both directions" },
  { value: "arabic_to_english", label: "Arabic → English" },
  { value: "english_to_arabic", label: "English → Arabic" },
];

const STATE_LABELS: Record<ComponentStateFilter, string> = {
  new: "New",
  learning: "Learning",
  mastered: "Mastered",
  weak: "Weak",
  due: "Due",
};

/** The state snapshot captured when a session starts (plan determinism). */
type StartSnapshot = {
  stored: Map<string, StoredComponentState>;
  weakScores: ReadonlyMap<string, number>;
  /**
   * The session's ONE resolved effective clock (§10.6): resolved here at
   * Start, used for the state-filter evaluation below, and handed to the
   * runner (`presetClock`) so grading stamps events with the SAME zone and
   * source — a custom session never resolves the clock twice.
   */
  clock: AttemptClock;
  /** The instant captured from `clock` at Start; the state filters and the
   * built plan both evaluate against it so the setup-screen guard and the
   * session can never disagree about what matched. */
  nowMs: number;
  /** Freshly re-read at Start (§19 "Study Again" — never a stale snapshot). */
  membership: CollectionMembership;
};

type RunningSession = {
  config: CustomSessionConfig;
  snapshot: StartSnapshot;
  token: number;
};

export function CustomSession() {
  const { state, retry } = useActiveContent();
  const { defaults, loaded: defaultsLoaded } = useSessionDefaults();
  // Drives the setup screen's list picker only — Start/Study Again always
  // re-read membership fresh from Dexie (§19), never from this snapshot.
  const { state: collectionsUi } = useCollections();
  const availableLists =
    collectionsUi.status === "ready" ? collectionsUi.snapshot.lists : [];
  const searchParams = useSearchParams();

  // Seeded ONCE from the URL present at mount (§20/§21) — never re-applied
  // on a later searchParams change, so a subsequent in-page filter edit is
  // never fought by the preset. A reload re-mounts the component and
  // re-reads the (unmodified) URL, so the preset survives a reload without
  // any extra persistence.
  const [filters, setFilters] = useState<CustomSessionFilters>(() => ({
    ...OPEN_CUSTOM_FILTERS,
    collections: parseCollectionPreset(new URLSearchParams(searchParams)),
  }));
  /** Draft inputs (strings so partially-typed values never crash). */
  const [countDraft, setCountDraft] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState<string>(
    String(DEFAULT_TIMED_LIMIT_MS / 1000),
  );
  const [pageMinDraft, setPageMinDraft] = useState<string>("");
  const [pageMaxDraft, setPageMaxDraft] = useState<string>("");
  const [timed, setTimed] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [running, setRunning] = useState<RunningSession | null>(null);
  const [guard, setGuard] = useState<LooseningSuggestion[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const isTranslationMode =
    filters.mode === "mc" || filters.mode === "flashcards";
  const isFlashcards = filters.mode === "flashcards";

  // The empty-result guard replaces nothing visually near the Start button, so
  // move focus onto it when it appears — a screen-reader user otherwise gets
  // no indication that the start produced no session (role="status" alone is
  // unreliable for content mounted WITH the region).
  const guardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (guard !== null) guardRef.current?.focus();
  }, [guard]);

  const update = (next: Partial<CustomSessionFilters>) => {
    setFilters((current) => ({ ...current, ...next }));
    setGuard(null);
  };

  const toggleIn = <T,>(list: readonly T[], value: T): T[] =>
    list.includes(value)
      ? list.filter((item) => item !== value)
      : [...list, value];

  // Arabic display pairs for bāb / verb type, read from the loaded release
  // (programmatic values, never hand-typed — hard rule 3). Verb types only
  // count entries whose classification is quiz-eligible, so the unverified
  // entries can never contribute a label.
  const babArabicById = useMemo(() => {
    const map = new Map<BabId, string>();
    if (state.status !== "ready") return map;
    for (const entry of state.entries) {
      if (!map.has(entry.bab)) map.set(entry.bab, entry.bab_arabic);
    }
    return map;
  }, [state]);
  const verbTypeArabicById = useMemo(() => {
    const map = new Map<VerbTypeId, string>();
    if (state.status !== "ready") return map;
    for (const entry of state.entries) {
      if (entry.quiz_eligibility.verb_type && !map.has(entry.verb_type)) {
        map.set(entry.verb_type, entry.verb_type_arabic);
      }
    }
    return map;
  }, [state]);

  const effectiveFilters = useCallback((): CustomSessionFilters => {
    const parsePage = (draft: string): number | null => {
      const parsed = Number.parseInt(draft, 10);
      return Number.isNaN(parsed) ? null : parsed;
    };
    return {
      ...filters,
      bookPages: {
        min: parsePage(pageMinDraft),
        max: parsePage(pageMaxDraft),
      },
    };
  }, [filters, pageMinDraft, pageMaxDraft]);

  const start = useCallback(async () => {
    if (state.status !== "ready" || starting) return;
    setStarting(true);
    setGuard(null);
    setStartError(null);
    try {
      const db = getSafwaDb();
      const snapshot = await readSchedulingSnapshot(db);
      const stored = new Map(
        snapshot.components.map((component) => [
          component.componentKey,
          component,
        ]),
      );
      // The session's ONE effective-clock resolution (§10.6): this clock is
      // frozen into the snapshot and later handed to the runner, so the
      // state-filter evaluation here and the graded events share one zone.
      const clock = await readEffectiveClock(db);
      const nowMs = clock.now();
      // Phase 13 weakness v2: the ONE authoritative score, shared with Weak
      // Areas and mixed revision (never a second/parallel weakness
      // computation for the Custom Session weak filter — §22 agreement).
      const derived = deriveAllComponents(state.entries);
      const weakScores = await loadWeakScores(db, derived, nowMs);
      // Bookmarks/lists are re-read fresh every Start — including "Study
      // again" — never from the setup screen's (possibly stale) live hook
      // snapshot: a list edit made mid-session must affect the next plan
      // (§19 "Study Again").
      const membership = await readCollectionMembership(db);
      const resolved = effectiveFilters();

      const matching = filterByStates(
        eligibleCustomComponents(state.entries, resolved, membership),
        resolved.states,
        stored,
        weakScores,
        nowMs,
      );
      if (matching.length === 0) {
        // Back to the setup screen with the guard — a "Study again" restart
        // whose filters no longer match anything (e.g. a New-only session
        // whose items were all just studied) must never plan stale items.
        setRunning(null);
        setGuard(
          looseningSuggestions(
            state.entries,
            resolved,
            { stored, weakScores, nowMs },
            membership,
          ),
        );
        return;
      }

      const parsedCount = Number.parseInt(
        countDraft ?? String(defaults.questionCount),
        10,
      );
      const count = Number.isNaN(parsedCount)
        ? defaults.questionCount
        : Math.min(100, Math.max(1, parsedCount));
      const parsedLimit = Number.parseInt(limitDraft, 10);
      const limitMs = Number.isNaN(parsedLimit)
        ? DEFAULT_TIMED_LIMIT_MS
        : Math.min(300, Math.max(5, parsedLimit)) * 1000;

      const config: CustomSessionConfig = {
        ...resolved,
        count,
        // Flashcards are self-paced and self-graded (§4.3): timed/test never
        // apply (the engine rejects them), and the controls are disabled.
        timed: isFlashcards ? false : timed,
        perQuestionLimitMs: limitMs,
        testMode: isFlashcards ? false : testMode,
      };
      setRunning((current) => ({
        config,
        snapshot: { stored, weakScores, clock, nowMs, membership },
        token: (current?.token ?? 0) + 1,
      }));
    } catch {
      // Reading the local scheduling state failed (e.g. storage unavailable);
      // recoverable — the learner can simply try again.
      setStartError("Couldn't start the session. Please try again.");
    } finally {
      setStarting(false);
    }
  }, [
    state,
    starting,
    effectiveFilters,
    countDraft,
    limitDraft,
    timed,
    testMode,
    isFlashcards,
    defaults.questionCount,
  ]);

  if (
    state.status === "loading" ||
    state.status === "error" ||
    !defaultsLoaded
  ) {
    return (
      <ContentStateFallback
        status={state.status === "error" ? "error" : "loading"}
        message={state.status === "error" ? state.message : undefined}
        ariaLabel="Loading custom session"
        retry={retry}
      />
    );
  }

  if (running) {
    return (
      <RunningCustomSession
        key={running.token}
        running={running}
        entries={state.entries}
        releaseId={state.releaseId}
        contentVersion={state.contentVersion}
        questionGeneratorVersion={state.questionGeneratorVersion}
        optionCount={defaults.optionCount}
        onAdjust={() => setRunning(null)}
        // Study again goes through the SAME start path as the setup screen:
        // it re-reads the scheduling snapshot, weak scores and clock, so
        // state filters (new/due/weak/…) are evaluated against what the
        // just-finished session persisted — never a stale pre-session map.
        onStudyAgain={() => void start()}
      />
    );
  }

  return (
    <div className="space-y-5" data-testid="custom-setup">
      <FilterGroup label="Mode">
        {MODE_OPTIONS.map((option) => (
          <Button
            key={option.value}
            type="button"
            className="min-h-11"
            variant={filters.mode === option.value ? "default" : "outline"}
            aria-pressed={filters.mode === option.value}
            data-testid={`custom-mode-${option.value}`}
            onClick={() => update({ mode: option.value })}
          >
            {option.label}
          </Button>
        ))}
      </FilterGroup>

      {isTranslationMode ? (
        <FilterGroup label="Direction">
          {DIRECTION_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              className="min-h-11"
              variant={
                filters.direction === option.value ? "default" : "outline"
              }
              aria-pressed={filters.direction === option.value}
              data-testid={`custom-direction-${option.value}`}
              onClick={() => update({ direction: option.value })}
            >
              {option.label}
            </Button>
          ))}
        </FilterGroup>
      ) : null}

      <FilterGroup
        label={isTranslationMode ? "Forms" : "Prompt forms"}
        hint="None selected = any eligible form"
      >
        {SOURCE_QUIZ_FORM_FIELDS.map((field) => (
          <Button
            key={field}
            type="button"
            className="min-h-11"
            variant={filters.forms.includes(field) ? "default" : "outline"}
            aria-pressed={filters.forms.includes(field)}
            data-testid={`custom-form-${field}`}
            onClick={() => update({ forms: toggleIn(filters.forms, field) })}
          >
            {FIELD_LABELS[field]}
          </Button>
        ))}
      </FilterGroup>

      <FilterGroup label="Bāb" hint="None selected = any bāb">
        {BAB_IDS.map((babId) => {
          const pair = babArabicById.get(babId);
          if (!pair) return null;
          return (
            <Button
              key={babId}
              type="button"
              className="min-h-11"
              variant={filters.babs.includes(babId) ? "default" : "outline"}
              aria-pressed={filters.babs.includes(babId)}
              data-testid={`custom-bab-${babId}`}
              onClick={() => update({ babs: toggleIn(filters.babs, babId) })}
            >
              <ArabicText className="text-lg">{pair}</ArabicText>
            </Button>
          );
        })}
      </FilterGroup>

      <FilterGroup label="Verb type" hint="None selected = any verb type">
        {VERB_TYPE_IDS.map((verbTypeId) => {
          const pair = verbTypeArabicById.get(verbTypeId);
          if (!pair) return null;
          return (
            <Button
              key={verbTypeId}
              type="button"
              className="min-h-11"
              variant={
                filters.verbTypes.includes(verbTypeId) ? "default" : "outline"
              }
              aria-pressed={filters.verbTypes.includes(verbTypeId)}
              data-testid={`custom-verbtype-${verbTypeId}`}
              onClick={() =>
                update({ verbTypes: toggleIn(filters.verbTypes, verbTypeId) })
              }
            >
              <ArabicText className="text-lg">{pair}</ArabicText>
            </Button>
          );
        })}
      </FilterGroup>

      <FilterGroup label="Progress state" hint="None selected = any state">
        {COMPONENT_STATE_FILTERS.map((stateFilter) => (
          <Button
            key={stateFilter}
            type="button"
            className="min-h-11"
            variant={
              filters.states.includes(stateFilter) ? "default" : "outline"
            }
            aria-pressed={filters.states.includes(stateFilter)}
            data-testid={`custom-state-${stateFilter}`}
            onClick={() =>
              update({ states: toggleIn(filters.states, stateFilter) })
            }
          >
            {STATE_LABELS[stateFilter]}
          </Button>
        ))}
      </FilterGroup>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground font-medium tracking-wide uppercase">
            Book page from
          </span>
          <Input
            type="number"
            inputMode="numeric"
            className="min-h-11 w-28"
            value={pageMinDraft}
            placeholder="any"
            data-testid="custom-page-min"
            onChange={(event) => {
              setPageMinDraft(event.target.value);
              setGuard(null);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground font-medium tracking-wide uppercase">
            Book page to
          </span>
          <Input
            type="number"
            inputMode="numeric"
            className="min-h-11 w-28"
            value={pageMaxDraft}
            placeholder="any"
            data-testid="custom-page-max"
            onChange={(event) => {
              setPageMaxDraft(event.target.value);
              setGuard(null);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground font-medium tracking-wide uppercase">
            Questions
          </span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            className="min-h-11 w-28"
            value={countDraft ?? String(defaults.questionCount)}
            data-testid="custom-count"
            onChange={(event) => setCountDraft(event.target.value)}
          />
        </label>
      </div>

      <FilterGroup label="Session options">
        <Button
          type="button"
          className="min-h-11"
          variant={timed && !isFlashcards ? "default" : "outline"}
          aria-pressed={timed && !isFlashcards}
          disabled={isFlashcards}
          data-testid="custom-timed"
          onClick={() => setTimed((current) => !current)}
        >
          Timed
        </Button>
        {timed && !isFlashcards ? (
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground font-medium tracking-wide uppercase">
              Seconds per question
            </span>
            <Input
              type="number"
              inputMode="numeric"
              min={5}
              max={300}
              className="min-h-11 w-24"
              value={limitDraft}
              data-testid="custom-limit"
              onChange={(event) => setLimitDraft(event.target.value)}
            />
          </label>
        ) : null}
        <Button
          type="button"
          className="min-h-11"
          variant={testMode && !isFlashcards ? "default" : "outline"}
          aria-pressed={testMode && !isFlashcards}
          disabled={isFlashcards}
          data-testid="custom-test-mode"
          onClick={() => setTestMode((current) => !current)}
        >
          Test mode
        </Button>
      </FilterGroup>
      {isFlashcards ? (
        <p className="text-muted-foreground text-xs">
          Flashcards are self-paced and self-graded, so timed and test mode
          don&apos;t apply.
        </p>
      ) : null}

      <FilterGroup
        label="Bookmarks & lists"
        hint="None selected = any vocabulary"
      >
        <Button
          type="button"
          className="min-h-11"
          variant={filters.collections.includeBookmarks ? "default" : "outline"}
          aria-pressed={filters.collections.includeBookmarks}
          data-testid="custom-collection-bookmarks"
          onClick={() =>
            update({
              collections: {
                ...filters.collections,
                includeBookmarks: !filters.collections.includeBookmarks,
              },
            })
          }
        >
          Bookmarks
        </Button>
        {availableLists.map((list) => (
          <Button
            key={list.id}
            type="button"
            className="min-h-11"
            variant={
              filters.collections.listIds.includes(list.id)
                ? "default"
                : "outline"
            }
            aria-pressed={filters.collections.listIds.includes(list.id)}
            data-testid={`custom-collection-list-${list.id}`}
            onClick={() =>
              update({
                collections: {
                  ...filters.collections,
                  listIds: toggleIn(filters.collections.listIds, list.id),
                },
              })
            }
          >
            {list.name}
          </Button>
        ))}
        {collectionsUi.status === "ready" && availableLists.length === 0 ? (
          <span className="text-muted-foreground text-xs">
            No custom lists yet.{" "}
            <Link
              href="/library/saved"
              className="text-primary underline-offset-4 hover:underline"
            >
              Create one from Saved Vocabulary
            </Link>
            .
          </span>
        ) : null}
      </FilterGroup>

      {guard !== null ? (
        <Card
          ref={guardRef}
          role="status"
          tabIndex={-1}
          data-testid="custom-empty-guard"
          className="focus:ring-ring/50 outline-none focus:ring-3"
        >
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">
                No questions match these filters
              </h2>
            </CardTitle>
            <CardDescription>
              Every question must match all active filters and be quiz-eligible.
              Try loosening one of these:
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {guard.map((suggestion) => (
                <li key={suggestion.axis} data-testid="loosen-suggestion">
                  {suggestion.label}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {startError !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {startError}
        </p>
      ) : null}

      <Button
        type="button"
        className="min-h-11 min-w-40"
        disabled={starting}
        onClick={() => void start()}
        data-testid="custom-start"
      >
        Start session
      </Button>
    </div>
  );
}

function FilterGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-muted-foreground w-full text-xs font-medium tracking-wide uppercase sm:w-auto sm:min-w-28">
        {label}
        {hint ? (
          <span className="text-muted-foreground block text-[11px] font-normal normal-case">
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </div>
  );
}

/** The running phase: mounts the right runner for the configured mode. */
function RunningCustomSession({
  running,
  entries,
  releaseId,
  contentVersion,
  questionGeneratorVersion,
  optionCount,
  onAdjust,
  onStudyAgain,
}: {
  running: RunningSession;
  entries: LearnerEntry[];
  releaseId: string;
  contentVersion: string;
  questionGeneratorVersion: string;
  optionCount: number;
  onAdjust: () => void;
  onStudyAgain: () => void;
}) {
  const { config, snapshot } = running;

  const buildPlan: QuizPlanBuilder & FlashcardPlanBuilder = useCallback(
    // The clock the runner would pass here IS snapshot.clock — threaded back
    // to it via `presetClock` below, so a custom session performs exactly ONE
    // effective-clock resolution (§10.6). This planner deliberately does not
    // take the clock parameter: the plan evaluates state filters at the
    // instant CAPTURED from that same clock at Start (snapshot.nowMs), never
    // a live re-read, so the setup-screen guard and the built plan can never
    // disagree about what matched.
    (planEntries: LearnerEntry[], seed: string) =>
      buildCustomPlan(
        planEntries,
        config,
        snapshot.stored,
        snapshot.weakScores,
        seed,
        snapshot.nowMs,
        snapshot.membership,
      ),
    [config, snapshot],
  );

  const delivery: QuizDelivery =
    config.timed && config.testMode
      ? "timed_test"
      : config.timed
        ? "timed"
        : config.testMode
          ? "test"
          : "immediate";

  const emptyMessage =
    "No questions match these filters any more. Adjust the filters and try again.";

  return (
    <div className="space-y-5" data-testid="custom-running">
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={onAdjust}
          data-testid="custom-adjust-filters"
        >
          Adjust filters
        </Button>
      </div>
      {config.mode === "flashcards" ? (
        <FlashcardRunner
          entries={entries}
          releaseId={releaseId}
          contentVersion={contentVersion}
          questionGeneratorVersion={questionGeneratorVersion}
          buildPlan={buildPlan}
          presetClock={snapshot.clock}
          emptyMessage={emptyMessage}
          onStudyAgain={onStudyAgain}
        />
      ) : (
        <QuizRunner
          entries={entries}
          releaseId={releaseId}
          contentVersion={contentVersion}
          questionGeneratorVersion={questionGeneratorVersion}
          buildPlan={buildPlan}
          delivery={delivery}
          perQuestionLimitMs={
            config.timed ? config.perQuestionLimitMs : undefined
          }
          optionCount={optionCount}
          presetClock={snapshot.clock}
          emptyMessage={emptyMessage}
          onStudyAgain={onStudyAgain}
        />
      )}
    </div>
  );
}
