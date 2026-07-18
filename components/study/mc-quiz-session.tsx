"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArabicText } from "@/components/arabic-text";
import { useActiveContent } from "@/components/content/use-active-content";
import {
  FieldValue,
  FIELD_LABELS,
  browserClock,
  formLabel,
  formName,
  isArabicField,
} from "@/components/study/study-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { uuidv7 } from "@/lib/uuid";
import {
  serializeAnswerReference,
  type AnswerReference,
} from "@/modules/content/answer-reference";
import type { SourceQuizFormField } from "@/modules/content/constants";
import { getSafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { newDeviceProfile, peekDeviceProfile } from "@/modules/profile/device";
import { ensureDurableGuestState } from "@/modules/profile/persistence";
import {
  createQuestionContext,
  type QuestionContext,
  type QuestionInstance,
  type QuestionOption,
} from "@/modules/study-engine/generator";
import {
  canUndo,
  createSession,
  currentQuestion,
  revealResults,
  submitAnswer,
  summarizeSession,
  undo,
  type QuestionFeedback,
  type SessionConfig,
  type SessionState,
} from "@/modules/study-engine/session";
import {
  buildQuizPlan,
  DEFAULT_MC_QUIZ_CONFIG,
  type McQuizConfig,
  type QuizDelivery,
  type QuizDirectionChoice,
  type QuizFieldChoice,
} from "@/modules/study-session/quizzes";
import {
  recordGradedAttempt,
  SupersededUndoError,
  undoGradedAttempt,
  type PersistedAttempt,
} from "@/modules/study-session/persistence";

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

/** Map the learner's delivery choice to the engine's session config (§4.4). */
function sessionConfigForDelivery(
  delivery: QuizDelivery,
): Partial<SessionConfig> {
  switch (delivery) {
    case "immediate":
      return { mode: "mc" };
    case "test":
      return { mode: "mc", testMode: true };
    case "timed":
      // The engine defaults the per-question limit to the documented 20s.
      return { mode: "mc", timed: true };
  }
}

/**
 * The prompt caption. The release's `meaning` is a BASE lexical meaning, not a
 * per-form translation, so the two directions differ deliberately (§4.5):
 * - Arabic→English (recognition): "Choose the base meaning" — the quizzed form
 *   is NOT named before answering (revealed with the feedback).
 * - English→Arabic (recall): the requested form IS named before answering,
 *   because the base meaning alone cannot distinguish māḍī from maṣdar etc.
 */
function promptCaption(instance: QuestionInstance): string {
  if (instance.answerField === "meaning") return "Choose the base meaning";
  return instance.sourceField !== null
    ? `Choose the ${formName(instance.sourceField)} form`
    : "Choose the correct Arabic form";
}

/**
 * The post-answer form line. For Ar→En this is the reveal of the previously
 * hidden form; for En→Ar it merely confirms the form already named in the
 * caption — neutral "Form: …" wording covers both without pretending the
 * En→Ar form had been hidden.
 */
function formFeedbackText(
  sourceField: SourceQuizFormField | null,
): string | null {
  if (sourceField === null) return null;
  return `Form: ${formLabel(sourceField)}`;
}

/** Top-level: loads content, hosts the options bar, and mounts the runner. */
export function McQuizSession() {
  const { state, retry } = useActiveContent();
  const [config, setConfig] = useState<McQuizConfig>(DEFAULT_MC_QUIZ_CONFIG);
  // Bumping this token remounts the runner, starting a fresh session (used by
  // "Study again" and by any options change).
  const [sessionToken, setSessionToken] = useState(0);

  if (state.status === "loading") {
    return (
      <div className="space-y-4" role="status" aria-label="Loading quiz">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <span className="sr-only">Loading quiz…</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{state.message}</p>
          <Button type="button" variant="outline" onClick={retry}>
            Retry loading content
          </Button>
        </CardContent>
      </Card>
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
        key={`${config.direction}|${config.field}|${config.delivery}|${sessionToken}`}
        entries={state.entries}
        releaseId={state.releaseId}
        contentVersion={state.contentVersion}
        questionGeneratorVersion={state.questionGeneratorVersion}
        config={config}
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

type RunnerStatus = "initialising" | "active" | "complete" | "empty" | "error";

/** Feedback captured for the just-answered question (immediate / timed modes). */
type AnsweredState = {
  instance: QuestionInstance;
  feedback: QuestionFeedback;
  selectedRef: AnswerReference | null;
  /** True when the response ran past the per-question limit (timed lapse). */
  timedOut: boolean;
};

function QuizRunner({
  entries,
  releaseId,
  contentVersion,
  questionGeneratorVersion,
  config,
  onStudyAgain,
}: {
  entries: LearnerEntry[];
  releaseId: string;
  contentVersion: string;
  questionGeneratorVersion: string;
  config: McQuizConfig;
  onStudyAgain: () => void;
}) {
  const [status, setStatus] = useState<RunnerStatus>("initialising");
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  // Feedback for the just-answered question (immediate/timed). Null while a
  // question is awaiting an answer or in test mode (feedback withheld).
  const [answered, setAnswered] = useState<AnsweredState | null>(null);
  // Transient, recoverable error from a failed grade/undo persistence write.
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped whenever a question is re-presented FRESH (single-step undo) so the
  // QuestionView remounts. Undo restores the same question id, so without this
  // React would reuse the mounted view and keep its stale per-question timer
  // state (an expired countdown, `shownAtRef`, `firedTimeout`) — leaving the
  // restored timed question un-answerable (every click reads as another lapse).
  const [viewEpoch, setViewEpoch] = useState(0);

  const context = useMemo<QuestionContext | null>(() => {
    try {
      return createQuestionContext({
        release_id: releaseId,
        content_version: contentVersion,
        question_generator_version: questionGeneratorVersion,
        entries,
      });
    } catch {
      return null;
    }
  }, [entries, releaseId, contentVersion, questionGeneratorVersion]);

  // The last persisted action, for single-step undo (see flashcard-session).
  const lastPersisted = useRef<PersistedAttempt | null>(null);
  const deviceBound = useRef(false);
  const sessionStartedAt = useRef<number>(0);

  // Build the session once per mount (a fresh mount == a fresh session).
  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getSafwaDb();
        sessionStartedAt.current = Date.now();
        const existing = await peekDeviceProfile(db);
        if (existing) deviceBound.current = true;
        const deviceId = existing?.deviceId ?? uuidv7();
        const seed = uuidv7();
        const plan = buildQuizPlan(entries, config, seed);
        if (cancelled) return;
        if (plan.length === 0) {
          setStatus("empty");
          return;
        }
        const state = createSession(
          {
            sessionId: uuidv7(),
            seed,
            deviceId,
            config: sessionConfigForDelivery(config.delivery),
            items: plan.map((item) => ({ identity: item.identity })),
          },
          context,
        );
        if (cancelled) return;
        setSession(state);
        setStatus("active");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context, entries, config]);

  const instance: QuestionInstance | null = useMemo(() => {
    if (!session || !context || session.status !== "active") return null;
    return currentQuestion(session, context);
  }, [session, context]);

  const answer = useCallback(
    async (selectedRef: AnswerReference | null, responseTimeMs: number) => {
      if (!session || !context || !instance || busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const db = getSafwaDb();
        const clock = browserClock();
        const result = submitAnswer(session, context, {
          attemptId: uuidv7(),
          questionInstanceId: instance.questionInstanceId,
          selectedAnswerRef: selectedRef ?? undefined,
          responseTimeMs: Math.max(0, responseTimeMs),
          clock,
        });
        const bindNow = !deviceBound.current;
        const persisted = await recordGradedAttempt(db, result.attempt, {
          eventId: uuidv7(),
          now: clock.now(),
          sessionStartedAt: sessionStartedAt.current || clock.now(),
          bindProfile: bindNow
            ? newDeviceProfile(session.deviceId, clock.now())
            : undefined,
        });
        if (bindNow) deviceBound.current = true;
        // Reconcile the committed device id into BOTH the state and its undo
        // snapshot (see flashcard-session for the concurrent-tab rationale).
        const nextState =
          persisted.deviceId === result.state.deviceId
            ? result.state
            : {
                ...result.state,
                deviceId: persisted.deviceId,
                previous: result.state.previous
                  ? { ...result.state.previous, deviceId: persisted.deviceId }
                  : null,
              };
        void ensureDurableGuestState(db).catch(() => {});
        lastPersisted.current = persisted;
        // Advance the engine immediately (so undo reverses THIS question), but
        // in immediate/timed mode hold the just-answered question on screen with
        // its feedback until the learner presses Next. Test mode withholds
        // feedback entirely and moves straight on.
        setSession(nextState);
        if (result.feedback) {
          // Drive the displayed selection + timeout SOLELY from the engine's
          // authoritative result — never the caller's inputs — so a click at the
          // timed cutoff (which the engine records as a no-selection lapse) can
          // never show a chosen option or a "correct" mark that disagrees with
          // the persisted attempt. In timed mode a null selection IS a lapse.
          const engineSelected = result.feedback.selectedAnswerRef;
          setAnswered({
            instance,
            feedback: result.feedback,
            selectedRef: engineSelected,
            timedOut: session.config.timed && engineSelected === null,
          });
        } else if (nextState.status === "complete") {
          setStatus("complete");
        }
      } catch {
        // The write is atomic (Dexie transaction) — nothing was half-saved and
        // the card has not advanced; surface a retryable error.
        setActionError("Couldn't save that. Please try again.");
        // In timed mode the question's countdown kept running through the
        // failed write, so WITHOUT a reset the advertised retry would be
        // unfair: an on-time answer whose write failed past the deadline would
        // re-derive as a lapse (engine time = past the limit), and the expiry
        // timer could even auto-submit one. Remount the view so the retry gets
        // a fresh countdown and response clock. (The error message lives on the
        // runner, so it survives the remount.)
        if (session.config.timed) setViewEpoch((epoch) => epoch + 1);
      } finally {
        setBusy(false);
      }
    },
    [session, context, instance, busy],
  );

  const advanceAfterFeedback = useCallback(() => {
    if (!session) return;
    setAnswered(null);
    setActionError(null);
    if (session.status === "complete") setStatus("complete");
  }, [session]);

  const undoLast = useCallback(async () => {
    if (!session || busy || !canUndo(session)) return;
    const persisted = lastPersisted.current;
    setBusy(true);
    setActionError(null);
    try {
      if (persisted) {
        await undoGradedAttempt(getSafwaDb(), persisted, Date.now());
      }
      lastPersisted.current = null;
      setSession(undo(session));
      setAnswered(null);
      setStatus("active");
      // Force a fresh QuestionView mount for the restored (same-id) question so
      // its per-question timer/response-time state resets to a full countdown.
      setViewEpoch((epoch) => epoch + 1);
    } catch (error) {
      // A superseded undo can never succeed; retire it so the button disables
      // (see flashcard-session for the full rationale).
      if (error instanceof SupersededUndoError) {
        lastPersisted.current = null;
        setSession({ ...session, previous: null });
        setActionError(
          "This question was reviewed again elsewhere and can no longer be undone.",
        );
      } else {
        setActionError("Couldn't undo that. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }, [session, busy]);

  if (!context || status === "error") {
    return (
      <Card>
        <CardContent role="alert" className="text-destructive text-sm">
          The quiz could not start. Please reload the page.
        </CardContent>
      </Card>
    );
  }

  if (status === "initialising") {
    return (
      <div role="status" aria-label="Preparing session">
        <Skeleton className="h-64 w-full rounded-xl" />
        <span className="sr-only">Preparing your quiz…</span>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          No eligible quiz questions match these options. Try a different form
          or direction.
        </CardContent>
      </Card>
    );
  }

  if (status === "complete" && session) {
    return (
      <ResultsScreen
        session={session}
        entriesById={context.entriesById}
        canUndo={canUndo(session)}
        busy={busy}
        actionError={actionError}
        onUndo={undoLast}
        onStudyAgain={onStudyAgain}
      />
    );
  }

  // While feedback is on screen we show the just-answered question; otherwise the
  // current (unanswered) question.
  const displayInstance = answered ? answered.instance : instance;
  if (!session || !displayInstance) return null;

  const entry = context.entriesById.get(displayInstance.entryId)!;
  return (
    <QuestionView
      key={`${displayInstance.questionInstanceId}:${viewEpoch}`}
      entry={entry}
      instance={displayInstance}
      position={displayInstance.position + 1}
      total={session.plan.length}
      delivery={config.delivery}
      perQuestionLimitMs={session.config.perQuestionLimitMs}
      answered={answered}
      canUndo={canUndo(session)}
      busy={busy}
      actionError={actionError}
      onAnswer={answer}
      onNext={advanceAfterFeedback}
      onUndo={undoLast}
    />
  );
}

/**
 * One question's view. Owns the per-question timer (timed mode) and stamps the
 * shown time so response duration is measured from a real clock. Options are
 * clickable until answered; after answering (immediate/timed) they are marked
 * and the quizzed form is revealed.
 */
function QuestionView({
  entry,
  instance,
  position,
  total,
  delivery,
  perQuestionLimitMs,
  answered,
  canUndo: undoAvailable,
  busy,
  actionError,
  onAnswer,
  onNext,
  onUndo,
}: {
  entry: LearnerEntry;
  instance: QuestionInstance;
  position: number;
  total: number;
  delivery: QuizDelivery;
  perQuestionLimitMs: number | null;
  answered: AnsweredState | null;
  canUndo: boolean;
  busy: boolean;
  actionError: string | null;
  onAnswer: (
    selectedRef: AnswerReference | null,
    responseTimeMs: number,
  ) => void;
  onNext: () => void;
  onUndo: () => void;
}) {
  const shownAtRef = useRef<number>(0);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const isTimed = delivery === "timed" && perQuestionLimitMs !== null;
  const [remainingMs, setRemainingMs] = useState<number>(
    perQuestionLimitMs ?? 0,
  );
  // Guards the one-shot timeout submit so a re-render can never fire it twice.
  const firedTimeout = useRef(false);

  useEffect(() => {
    shownAtRef.current = Date.now();
    firstOptionRef.current?.focus();
  }, []);

  // Move focus to Next when feedback appears so keyboard users continue easily.
  useEffect(() => {
    if (answered) nextRef.current?.focus();
  }, [answered]);

  // Per-question countdown (timed mode). Stops once the question is answered.
  useEffect(() => {
    if (!isTimed || perQuestionLimitMs === null || answered) return;
    const start = shownAtRef.current || Date.now();
    const tick = () => {
      const remaining = perQuestionLimitMs - (Date.now() - start);
      setRemainingMs(Math.max(0, remaining));
      if (remaining <= 0 && !firedTimeout.current) {
        firedTimeout.current = true;
        // Submit a lapse: no selection, response time at the limit (the engine
        // derives the timeout solely from response time, counting it incorrect).
        onAnswer(null, perQuestionLimitMs);
      }
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [isTimed, perQuestionLimitMs, answered, onAnswer]);

  const formLine = formFeedbackText(instance.sourceField);
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  return (
    <div
      className="space-y-4"
      data-testid="mc-quiz-session"
      data-entry-id={entry.id}
      data-prompt-field={instance.promptField}
      data-answer-field={instance.answerField}
      data-source-field={instance.sourceField ?? ""}
      data-delivery={delivery}
    >
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm" aria-live="polite">
          Question {position} of {total}
        </p>
        {isTimed && !answered ? (
          <p
            className="text-sm font-medium tabular-nums"
            data-testid="mc-timer"
            role="timer"
            aria-live="off"
          >
            {remainingSeconds}s
          </p>
        ) : null}
      </div>

      <Card>
        <CardContent className="space-y-2 py-8 text-center">
          <span
            className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
            data-testid="mc-prompt-caption"
          >
            {promptCaption(instance)}
          </span>
          {instance.promptField === "meaning" ? (
            // The En→Ar prompt shows the entry's BASE lexical meaning — label
            // it so the gloss is never read as a translation of one form.
            <p
              className="text-muted-foreground text-xs"
              data-testid="mc-base-meaning-label"
            >
              Base meaning
            </p>
          ) : null}
          <div className="flex items-center justify-center">
            <FieldValue entry={entry} field={instance.promptField} />
          </div>
        </CardContent>
      </Card>

      <div
        role="group"
        aria-label="Answer options"
        className="grid gap-3 sm:grid-cols-2"
      >
        {instance.options.map((option, index) => (
          <OptionButton
            key={serializeAnswerReference(option.ref)}
            ref={index === 0 ? firstOptionRef : undefined}
            option={option}
            answerField={instance.answerField}
            answered={answered}
            busy={busy}
            onChoose={() =>
              onAnswer(option.ref, Date.now() - shownAtRef.current)
            }
          />
        ))}
      </div>

      {actionError ? (
        <p role="alert" className="text-destructive text-center text-sm">
          {actionError}
        </p>
      ) : null}

      {answered ? (
        <Card data-testid="mc-feedback">
          <CardContent className="space-y-2" aria-live="polite">
            <p
              className={cn(
                "text-sm font-semibold",
                answered.feedback.isCorrect
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-destructive",
              )}
              data-testid="mc-feedback-outcome"
              data-correct={answered.feedback.isCorrect}
            >
              {answered.timedOut
                ? "Time's up — counted as incorrect."
                : answered.feedback.isCorrect
                  ? "Correct"
                  : "Incorrect"}
            </p>
            {/* The answer is the entry's BASE meaning paired with the quizzed
                form — never presented as an exact translation of that form. */}
            <p
              className="text-muted-foreground text-sm"
              data-testid="mc-base-meaning"
            >
              Base meaning: {entry.meaning}
            </p>
            {formLine ? (
              <p
                className="text-muted-foreground text-sm"
                data-testid="mc-form-reveal"
              >
                {formLine}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={!undoAvailable || busy}
          onClick={onUndo}
          data-testid="undo"
        >
          Undo
        </Button>
        <div className="flex items-center gap-3">
          {answered ? (
            <Button asChild variant="link" className="min-h-11">
              <Link
                href={`/library/${entry.id}`}
                data-testid="entry-detail-link"
              >
                View full entry
              </Link>
            </Button>
          ) : null}
          {answered ? (
            <Button
              type="button"
              className="min-h-11 min-w-24"
              disabled={busy}
              onClick={onNext}
              data-testid="mc-next"
              ref={nextRef}
            >
              Next
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A single answer option; marks correct/selected state after answering. */
const OptionButton = ({
  ref,
  option,
  answerField,
  answered,
  busy,
  onChoose,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  option: QuestionOption;
  answerField: QuestionInstance["answerField"];
  answered: AnsweredState | null;
  busy: boolean;
  onChoose: () => void;
}) => {
  const isSelected =
    answered?.selectedRef !== undefined &&
    answered?.selectedRef !== null &&
    answered.selectedRef.entryId === option.ref.entryId &&
    answered.selectedRef.field === option.ref.field;
  // Mark the correct option by IDENTITY (the option flagged correct at
  // generation), so feedback never re-derives correctness in the UI.
  const isCorrectOption = answered !== null && option.isCorrect;
  const showState = answered !== null;

  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      disabled={showState || busy}
      aria-pressed={isSelected}
      onClick={onChoose}
      data-testid="mc-option"
      data-answer-ref={serializeAnswerReference(option.ref)}
      data-correct={isCorrectOption}
      data-selected={isSelected}
      className={cn(
        "min-h-14 flex-col gap-1 px-4 py-2 text-center whitespace-normal",
        showState &&
          isCorrectOption &&
          "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40",
        showState &&
          isSelected &&
          !isCorrectOption &&
          "border-destructive bg-destructive/10",
        // Keep answered options fully legible (override the disabled dimming).
        showState && "opacity-100",
      )}
    >
      {isArabicField(answerField) ? (
        <ArabicText className="text-2xl">{option.displayValue}</ArabicText>
      ) : (
        <span className="text-base">{option.displayValue}</span>
      )}
      {/* After answering, mark state with TEXT + a symbol (never colour alone —
          WCAG 1.4.1) so colour-blind learners can tell which option was right. */}
      {showState && isCorrectOption ? (
        <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
          {isSelected ? "✓ Correct — your answer" : "✓ Correct answer"}
        </span>
      ) : showState && isSelected ? (
        <span className="text-destructive text-xs font-semibold">
          ✗ Your answer
        </span>
      ) : null}
    </Button>
  );
};

function ResultsScreen({
  session,
  entriesById,
  canUndo: undoAvailable,
  busy,
  actionError,
  onUndo,
  onStudyAgain,
}: {
  session: SessionState;
  entriesById: ReadonlyMap<number, LearnerEntry>;
  canUndo: boolean;
  busy: boolean;
  actionError: string | null;
  onUndo: () => void;
  onStudyAgain: () => void;
}) {
  const summary = summarizeSession(session);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Test mode withheld per-question correctness inline; reveal it now (§4.4).
  const isTest = session.config.testMode;
  const outcomes: QuestionFeedback[] = isTest ? revealResults(session) : [];

  return (
    <Card data-testid="mc-results">
      <CardContent className="space-y-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          Quiz complete
        </h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat
            label="Questions"
            value={summary.componentsSeen}
            testId="mc-questions"
          />
          <Stat
            label="Correct first try"
            value={summary.firstAttemptCorrect}
            testId="mc-first-attempt-correct"
          />
          <Stat
            label="Recovered"
            value={summary.recovered}
            testId="mc-recovered"
          />
          <Stat label="Hinted" value={summary.hinted} testId="mc-hinted" />
        </dl>

        {actionError ? (
          <p role="alert" className="text-destructive text-sm">
            {actionError}
          </p>
        ) : null}

        {isTest ? (
          <div className="space-y-2" data-testid="mc-test-breakdown">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Your answers
            </h3>
            <ul className="space-y-1 text-sm">
              {session.attempts.map((attempt, index) => {
                const outcome = outcomes[index];
                const answerEntry = entriesById.get(attempt.entryId);
                // Test mode withholds correctness inline; the quizzed form is
                // still revealed here (per direction) so criterion 3/4's "reveal
                // shows the form" holds in test mode too.
                const rowFormLabel = attempt.sourceField
                  ? formLabel(attempt.sourceField)
                  : null;
                return (
                  <li
                    key={attempt.id}
                    data-testid="mc-result-outcome"
                    data-correct={outcome?.isCorrect ?? false}
                    data-source-field={attempt.sourceField ?? ""}
                    className="flex items-center justify-between gap-3"
                  >
                    <span>
                      {/* Test mode defers ALL feedback to this screen, so the
                          gloss must be labelled here too — never presented as
                          the exact translation of the named form. */}
                      {answerEntry
                        ? `Base meaning: ${answerEntry.meaning}`
                        : `Entry ${attempt.entryId}`}
                      {rowFormLabel ? (
                        <span
                          className="text-muted-foreground"
                          data-testid="mc-result-form"
                        >
                          {" "}
                          · Form: {rowFormLabel}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "font-medium",
                        outcome?.isCorrect
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-destructive",
                      )}
                    >
                      {outcome?.isCorrect ? "Correct" : "Incorrect"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className="min-h-11"
            onClick={onStudyAgain}
            data-testid="study-again"
          >
            Study again
          </Button>
          {undoAvailable ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={onUndo}
              data-testid="undo"
            >
              Undo last question
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId?: string;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
