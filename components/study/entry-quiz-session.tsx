"use client";

/**
 * Bāb / root identification quiz sessions (Phase 10). Entry-level components on
 * the shared MC runner: the learner sees one eligible Arabic form of an entry
 * and picks its bāb (shown as Arabic pattern pairs — never numbering,
 * CLAUDE.md hard rule 5) or its three-radical root. The prompt form is
 * configurable (default māḍī; a specific form or a random eligible form per
 * question) and is recorded on every attempt via the generated question's
 * prompt field.
 */
import { useCallback, useState } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import {
  ContentStateFallback,
  QuizRunner,
  type QuizPlanEntry,
} from "@/components/study/quiz-runner";
import { FIELD_LABELS } from "@/components/study/study-shared";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  buildEntryQuizPlan,
  type EntryQuizSkill,
  type PromptFormChoice,
} from "@/modules/study-session/entry-quizzes";
import { DEFAULT_ENTRY_LEVEL_PROMPT_FORM } from "@/modules/study-engine/generator";

const PROMPT_FORM_OPTIONS: { value: PromptFormChoice; label: string }[] = [
  { value: "madi", label: `${FIELD_LABELS.madi} — default` },
  { value: "mudari", label: FIELD_LABELS.mudari },
  { value: "ism_fail", label: FIELD_LABELS.ism_fail },
  { value: "masdar", label: FIELD_LABELS.masdar },
  { value: "amr", label: FIELD_LABELS.amr },
  { value: "nahi", label: FIELD_LABELS.nahi },
  { value: "random", label: "Random eligible form" },
];

const EMPTY_MESSAGES: Record<EntryQuizSkill, string> = {
  bab_identification:
    "No eligible questions for this prompt form. Try a different form.",
  root_identification:
    "No eligible root questions for this prompt form. Try a different form.",
};

/** Top-level: loads content, hosts the prompt-form bar, mounts the runner. */
export function EntryQuizSession({ skill }: { skill: EntryQuizSkill }) {
  const { state, retry } = useActiveContent();
  // The learner-editable session defaults (§4.4): count + option count.
  const { defaults, loaded: defaultsLoaded } = useSessionDefaults();
  const [promptForm, setPromptForm] = useState<PromptFormChoice>(
    DEFAULT_ENTRY_LEVEL_PROMPT_FORM,
  );
  // Bumping this token remounts the runner, starting a fresh session (used by
  // "Study again" and by any prompt-form change).
  const [sessionToken, setSessionToken] = useState(0);

  const buildPlan = useCallback(
    (entries: LearnerEntry[], seed: string): QuizPlanEntry[] =>
      buildEntryQuizPlan(
        entries,
        { skill, promptForm },
        seed,
        defaults.questionCount,
      ),
    [skill, promptForm, defaults.questionCount],
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

  return (
    <div className="space-y-5">
      <div
        className="flex flex-wrap items-end gap-4"
        data-testid="entry-quiz-options"
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground font-medium tracking-wide uppercase">
            Prompt form
          </span>
          <select
            className="border-border bg-background min-h-11 rounded-lg border px-2 text-sm"
            value={promptForm}
            aria-label="Prompt form"
            data-testid="prompt-form-select"
            onChange={(event) => {
              setPromptForm(event.target.value as PromptFormChoice);
              setSessionToken((token) => token + 1);
            }}
          >
            {PROMPT_FORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <QuizRunner
        key={`${skill}|${promptForm}|${defaults.questionCount}|${defaults.optionCount}|${sessionToken}`}
        entries={state.entries}
        releaseId={state.releaseId}
        contentVersion={state.contentVersion}
        questionGeneratorVersion={state.questionGeneratorVersion}
        buildPlan={buildPlan}
        delivery="immediate"
        optionCount={defaults.optionCount}
        emptyMessage={EMPTY_MESSAGES[skill]}
        onStudyAgain={() => setSessionToken((token) => token + 1)}
      />
    </div>
  );
}
