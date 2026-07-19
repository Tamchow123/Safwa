"use client";

import { useCallback, useState } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import {
  ContentStateFallback,
  QuizRunner,
  type QuizPlanEntry,
} from "@/components/study/quiz-runner";
import { FIELD_LABELS } from "@/components/study/study-shared";
import { Button } from "@/components/ui/button";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  buildQuizPlan,
  DEFAULT_MC_QUIZ_CONFIG,
  type McQuizConfig,
  type QuizDelivery,
  type QuizDirectionChoice,
  type QuizFieldChoice,
} from "@/modules/study-session/quizzes";

const DIRECTION_OPTIONS: { value: QuizDirectionChoice; label: string }[] = [
  { value: "arabic_to_english", label: "Arabic → English" },
  { value: "english_to_arabic", label: "English → Arabic" },
  { value: "random", label: "Both directions" },
];

const FIELD_OPTIONS: { value: QuizFieldChoice; label: string }[] = [
  { value: "random", label: "Any eligible form" },
  { value: "madi", label: FIELD_LABELS.madi },
  { value: "mudari", label: FIELD_LABELS.mudari },
  { value: "masdar", label: FIELD_LABELS.masdar },
  { value: "ism_fail", label: FIELD_LABELS.ism_fail },
  { value: "amr", label: FIELD_LABELS.amr },
  { value: "nahi", label: FIELD_LABELS.nahi },
];

const DELIVERY_OPTIONS: { value: QuizDelivery; label: string }[] = [
  { value: "immediate", label: "Immediate feedback" },
  { value: "test", label: "Test mode" },
  { value: "timed", label: "Timed" },
];

/** Top-level: loads content, hosts the options bar, and mounts the runner. */
export function McQuizSession() {
  const { state, retry } = useActiveContent();
  // The learner-editable session defaults (§4.4): count + option count.
  const { defaults, loaded: defaultsLoaded } = useSessionDefaults();
  const [config, setConfig] = useState<McQuizConfig>(DEFAULT_MC_QUIZ_CONFIG);
  // Bumping this token remounts the runner, starting a fresh session (used by
  // "Study again" and by any options change).
  const [sessionToken, setSessionToken] = useState(0);

  const buildPlan = useCallback(
    (entries: LearnerEntry[], seed: string): QuizPlanEntry[] =>
      buildQuizPlan(entries, config, seed, defaults.questionCount),
    [config, defaults.questionCount],
  );

  if (
    state.status === "loading" ||
    state.status === "error" ||
    !defaultsLoaded
  ) {
    return (
      <ContentStateFallback
        status={state.status === "error" ? "error" : "loading"}
        message={state.status === "error" ? state.message : undefined}
        ariaLabel="Loading quiz"
        retry={retry}
      />
    );
  }

  const updateConfig = (next: Partial<McQuizConfig>) => {
    setConfig((current) => ({ ...current, ...next }));
    setSessionToken((token) => token + 1);
  };

  return (
    <div className="space-y-5">
      <OptionsBar config={config} onChange={updateConfig} />
      <QuizRunner
        key={`${config.direction}|${config.field}|${config.delivery}|${defaults.questionCount}|${defaults.optionCount}|${sessionToken}`}
        entries={state.entries}
        releaseId={state.releaseId}
        contentVersion={state.contentVersion}
        questionGeneratorVersion={state.questionGeneratorVersion}
        buildPlan={buildPlan}
        delivery={config.delivery}
        optionCount={defaults.optionCount}
        emptyMessage="No eligible quiz questions match these options. Try a different form or direction."
        onStudyAgain={() => setSessionToken((token) => token + 1)}
      />
    </div>
  );
}

function OptionsBar({
  config,
  onChange,
}: {
  config: McQuizConfig;
  onChange: (next: Partial<McQuizConfig>) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-end gap-4"
      data-testid="mc-quiz-options"
    >
      <div
        role="group"
        aria-label="Direction"
        className="flex flex-wrap items-center gap-2"
      >
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Direction
        </span>
        {DIRECTION_OPTIONS.map((option) => (
          <Button
            key={option.value}
            type="button"
            className="min-h-11"
            variant={config.direction === option.value ? "default" : "outline"}
            aria-pressed={config.direction === option.value}
            onClick={() => onChange({ direction: option.value })}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground font-medium tracking-wide uppercase">
          Form
        </span>
        <select
          className="border-border bg-background min-h-11 rounded-lg border px-2 text-sm"
          value={config.field}
          aria-label="Form"
          onChange={(event) =>
            onChange({ field: event.target.value as QuizFieldChoice })
          }
        >
          {FIELD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground font-medium tracking-wide uppercase">
          Mode
        </span>
        <select
          className="border-border bg-background min-h-11 rounded-lg border px-2 text-sm"
          value={config.delivery}
          aria-label="Mode"
          data-testid="mc-delivery-select"
          onChange={(event) =>
            onChange({ delivery: event.target.value as QuizDelivery })
          }
        >
          {DELIVERY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
