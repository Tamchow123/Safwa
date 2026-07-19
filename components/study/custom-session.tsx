"use client";

/**
 * Custom session configuration (Phase 11) — the full §4.4 filter matrix on one
 * setup screen: mode, direction, form(s), bāb, verb type, book page range,
 * state filters, question count, timed and test mode, plus the bookmarks /
 * custom lists placeholder (disabled until Phase 14).
 *
 * Bāb and verb-type choices display their Arabic pairs read from the loaded
 * release (never numbering, never hand-typed Arabic — hard rules 3/5). The
 * matching component set comes from the pure `modules/study-session/custom`
 * filter engine; an empty result renders the loosening-suggestions guard
 * instead of a session (§4.4 empty-result guard).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArabicText } from "@/components/arabic-text";
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
import { browserClock, FIELD_LABELS } from "@/components/study/study-shared";
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
import { getSafwaDb } from "@/modules/content/db";
import {
  BAB_IDS,
  SOURCE_QUIZ_FORM_FIELDS,
  VERB_TYPE_IDS,
  type BabId,
  type VerbTypeId,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
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
import {
  computeWeakScores,
  type StoredComponentState,
} from "@/modules/study-session/mixed";
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
  weakScores: Map<string, number>;
  nowMs: number;
};

type RunningSession = {
  config: CustomSessionConfig;
  snapshot: StartSnapshot;
  token: number;
};

export function CustomSession() {
  const { state, retry } = useActiveContent();
  const { defaults, loaded: defaultsLoaded } = useSessionDefaults();

  const [filters, setFilters] = useState<CustomSessionFilters>({
    ...OPEN_CUSTOM_FILTERS,
  });
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
      const snapshot = await readSchedulingSnapshot(getSafwaDb());
      const stored = new Map(
        snapshot.components.map((component) => [
          component.componentKey,
          component,
        ]),
      );
      const weakScores = computeWeakScores(snapshot.attempts);
      const nowMs = browserClock().now();
      const resolved = effectiveFilters();

      const matching = filterByStates(
        eligibleCustomComponents(state.entries, resolved),
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
          looseningSuggestions(state.entries, resolved, {
            stored,
            weakScores,
            nowMs,
          }),
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
        snapshot: { stored, weakScores, nowMs },
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

      {/* Bookmarks / custom lists ship with lists in Phase 14 — the §4.4
          matrix keeps their place visible but inert until then. */}
      <div
        className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm"
        data-testid="custom-bookmarks-placeholder"
      >
        <Button type="button" variant="outline" className="min-h-11" disabled>
          Bookmarks &amp; lists
        </Button>
        <span className="text-xs">
          Coming soon — filter by bookmarks and custom lists once lists arrive.
        </span>
      </div>

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
    (planEntries: LearnerEntry[], seed: string) =>
      buildCustomPlan(
        planEntries,
        config,
        snapshot.stored,
        snapshot.weakScores,
        seed,
        snapshot.nowMs,
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
          emptyMessage={emptyMessage}
          onStudyAgain={onStudyAgain}
        />
      )}
    </div>
  );
}
