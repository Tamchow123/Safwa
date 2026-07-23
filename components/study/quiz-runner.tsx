"use client";

/**
 * The shared multiple-choice session runner (Phase 9/10). One implementation of
 * the question → answer → feedback → results loop, parameterised by a plan
 * builder, so the vocabulary quizzes (Phase 9), the bāb/root quizzes and the
 * mixed "Start studying" session (Phase 10) all share the same grading,
 * persistence, undo and timer machinery — and the same test hooks (the
 * `mc-*` data-testids are the shared contract for every MC-style mode).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArabicText } from "@/components/arabic-text";
import { BookmarkToggle } from "@/components/collections/bookmark-toggle";
import { useCollections } from "@/components/collections/use-collections";
import { useSessionEndSync } from "@/components/sync/sync-provider";
import {
  FieldValue,
  formLabel,
  formName,
  isArabicField,
} from "@/components/study/study-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { uuidv7 } from "@/lib/uuid";
import { DB_READ_TIMEOUT_MS, withTimeout } from "@/lib/with-timeout";
import {
  serializeAnswerReference,
  type AnswerReference,
} from "@/modules/content/answer-reference";
import type { SourceQuizFormField } from "@/modules/content/constants";
import { toggleBookmark } from "@/modules/collections/persistence";
import { getSafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { newDeviceProfile, peekDeviceProfile } from "@/modules/profile/device";
import { ensureDurableGuestState } from "@/modules/profile/persistence";
import {
  DEFAULT_TIMEZONE_PREFERENCE,
  readEffectiveClock,
  resolveEffectiveClock,
} from "@/modules/profile/timezone";
import type { AttemptClock } from "@/modules/study-engine/attempts";
import { isSourceFormField } from "@/modules/study-engine/fields";
import {
  createQuestionContext,
  type HintState,
  type QuestionContext,
  type QuestionInstance,
  type QuestionOption,
} from "@/modules/study-engine/generator";
import { availableHints, type HintContent } from "@/modules/study-engine/hints";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
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
import type { QuizDelivery } from "@/modules/study-session/quizzes";
import {
  recordGradedAttempt,
  SupersededUndoError,
  undoGradedAttempt,
  type PersistedAttempt,
} from "@/modules/study-session/persistence";

/** One planned item: a component identity plus an optional entry-level prompt
 * form (bāb/root; ignored for translation components). */
export type QuizPlanEntry = {
  identity: ComponentIdentity;
  promptForm?: SourceQuizFormField;
};

/**
 * Build the session plan for one mount. May read local state (async). The
 * clock is the session's FROZEN effective clock (§10.6) — planners that need
 * "today" or "now" must use it, never an ambient clock of their own.
 */
export type QuizPlanBuilder = (
  entries: LearnerEntry[],
  seed: string,
  clock: AttemptClock,
) => QuizPlanEntry[] | Promise<QuizPlanEntry[]>;

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
    case "timed_test":
      // The Phase-11 combined composition: countdown AND withheld feedback.
      return { mode: "mc", timed: true, testMode: true };
  }
}

/** Does this delivery run the per-question countdown? */
function isTimedDelivery(delivery: QuizDelivery): boolean {
  return delivery === "timed" || delivery === "timed_test";
}

/**
 * The prompt caption, by what the question asks for. The release's `meaning`
 * is a BASE lexical meaning, not a per-form translation, so the two
 * translation directions differ deliberately (§4.5):
 * - Arabic→English (recognition): "Choose the base meaning" — the quizzed form
 *   is NOT named before answering (revealed with the feedback).
 * - English→Arabic (recall): the requested form IS named before answering,
 *   because the base meaning alone cannot distinguish māḍī from maṣdar etc.
 * Entry-level questions ask for the entry's bāb / root / verb type.
 */
function promptCaption(instance: QuestionInstance): string {
  switch (instance.answerField) {
    case "meaning":
      return "Choose the base meaning";
    case "bab":
      return "Choose the bāb";
    case "root":
      return "Choose the root";
    case "verb_type":
      return "Choose the verb type";
    default:
      return `Choose the ${formName(instance.answerField)} form`;
  }
}

/**
 * The source form the feedback names. For Ar→En this is the reveal of the
 * previously hidden form; for En→Ar it confirms the form already named in the
 * caption; for entry-level questions (bāb/root) it names the prompt form that
 * was shown. Neutral "Form: …" wording covers all three.
 */
function revealedFormField(
  instance: QuestionInstance,
): SourceQuizFormField | null {
  if (instance.sourceField !== null) return instance.sourceField;
  return isSourceFormField(instance.promptField) ? instance.promptField : null;
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

export function QuizRunner({
  entries,
  releaseId,
  contentVersion,
  questionGeneratorVersion,
  buildPlan,
  delivery,
  perQuestionLimitMs,
  optionCount,
  presetClock,
  emptyMessage,
  onStudyAgain,
}: {
  entries: LearnerEntry[];
  releaseId: string;
  contentVersion: string;
  questionGeneratorVersion: string;
  /** Must be referentially stable per mount (callers memoise + remount by key). */
  buildPlan: QuizPlanBuilder;
  delivery: QuizDelivery;
  /** Timed deliveries only: per-question limit (engine default 20s if omitted). */
  perQuestionLimitMs?: number;
  /** MC options per question (§4.4 — engine default 4 if omitted). */
  optionCount?: number;
  /**
   * An ALREADY-RESOLVED effective clock to freeze for this session. Callers
   * that resolve the clock before mounting (Custom Session resolves it during
   * setup-screen state filtering) pass it here so one session never resolves
   * the clock twice; when omitted the runner resolves it once at mount.
   */
  presetClock?: AttemptClock;
  emptyMessage: string;
  onStudyAgain: () => void;
}) {
  const [status, setStatus] = useState<RunnerStatus>("initialising");
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  // Nudge an end-of-session sync when the run completes (§18 "push at
  // successful session end"). A no-op for guests / outside a SyncProvider.
  const notifySessionEnd = useSessionEndSync();
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
  // The single hint taken for the CURRENT question. Owned by the runner, NOT
  // the question view: a failed persistence write remounts the view (fresh
  // countdown), and hint exposure is learning state that must survive that
  // retry — otherwise a transient IndexedDB failure would upgrade a hinted
  // answer to full credit (Good instead of Hard). Cleared only when the
  // session ADVANCES past the question (next / test-mode auto-advance / undo).
  const [usedHint, setUsedHint] = useState<HintContent | null>(null);

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
  // The session's FROZEN effective clock (§10.6): resolved ONCE per session
  // (either supplied pre-resolved via `presetClock`, or read at mount from
  // the stored timezone preference), then used for planning AND every graded
  // attempt, so all events in one session share the same zone + source. A
  // preference change applies to sessions started afterwards. MIRRORED in
  // flashcard-session.tsx — keep the two implementations in sync.
  const sessionClock = useRef<AttemptClock | null>(null);

  // Build the session once per mount (a fresh mount == a fresh session).
  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    // Bounded (REL-P101): a hung IndexedDB open (e.g. blocked behind another
    // tab's schema upgrade) must not strand this session on the "Preparing
    // session" skeleton forever with no retry. These are pure reads before
    // any write occurs, so racing them against a timer carries none of the
    // duplicate-write risk that rules out bounding the grading write below.
    // The timeout is made TERMINAL by setting `cancelled` in the catch (not
    // just on unmount): Promise.race cannot stop the IIFE below, so without
    // this a slow-then-eventually-resolves read would silently flip the
    // shown error back to an active/empty session with no user action.
    // MIRRORED in flashcard-session.tsx — keep the two in sync.
    void withTimeout(
      (async () => {
        const db = getSafwaDb();
        sessionStartedAt.current = Date.now();
        const clock = presetClock ?? (await readEffectiveClock(db));
        if (cancelled) return;
        sessionClock.current = clock;
        const existing = await peekDeviceProfile(db);
        if (cancelled) return;
        if (existing) deviceBound.current = true;
        const deviceId = existing?.deviceId ?? uuidv7();
        const seed = uuidv7();
        const plan = await buildPlan(entries, seed, sessionClock.current);
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
            config: {
              ...sessionConfigForDelivery(delivery),
              ...(perQuestionLimitMs !== undefined && isTimedDelivery(delivery)
                ? { perQuestionLimitMs }
                : {}),
              ...(optionCount !== undefined ? { optionCount } : {}),
            },
            items: plan.map((item) => ({
              identity: item.identity,
              promptForm: item.promptForm,
            })),
          },
          context,
        );
        if (cancelled) return;
        setSession(state);
        setStatus("active");
      })(),
      DB_READ_TIMEOUT_MS,
      "session initialization timed out",
    ).catch(() => {
      if (!cancelled) {
        cancelled = true;
        setStatus("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    context,
    entries,
    buildPlan,
    delivery,
    perQuestionLimitMs,
    optionCount,
    presetClock,
  ]);

  // When the run completes, request an end-of-session sync (§18). notifySessionEnd
  // is a stable no-op outside a SyncProvider / for guests, so this is safe here.
  useEffect(() => {
    if (status === "complete") notifySessionEnd();
  }, [status, notifySessionEnd]);

  // Render-time question generation is guarded: a generation failure (e.g. a
  // pool unable to fill the configured option count in an unforeseen case)
  // must surface as the recoverable error card, never an uncaught render
  // exception that blanks the app mid-session.
  const instance: QuestionInstance | null | "generation_failed" =
    useMemo(() => {
      if (!session || !context || session.status !== "active") return null;
      try {
        return currentQuestion(session, context);
      } catch {
        return "generation_failed";
      }
    }, [session, context]);

  const answer = useCallback(
    async (
      selectedRef: AnswerReference | null,
      responseTimeMs: number,
      hint?: HintState,
    ) => {
      if (!session || !context || !instance || busy) return;
      if (instance === "generation_failed") return;
      setBusy(true);
      setActionError(null);
      try {
        const db = getSafwaDb();
        // The session-frozen clock; the fallback (unreachable while a session
        // is active) still goes through the shared resolver, never an
        // unconditional browser clock. MIRRORED in flashcard-session.tsx —
        // keep the two fallback blocks in sync.
        const clock =
          sessionClock.current ??
          resolveEffectiveClock(DEFAULT_TIMEZONE_PREFERENCE);
        const result = submitAnswer(session, context, {
          attemptId: uuidv7(),
          questionInstanceId: instance.questionInstanceId,
          selectedAnswerRef: selectedRef ?? undefined,
          hint,
          responseTimeMs: Math.max(0, responseTimeMs),
          clock,
        });
        const bindNow = !deviceBound.current;
        // Deliberately UNBOUNDED (unlike the read-side loads, which race a
        // watchdog via lib/with-timeout.ts): Promise.race cannot cancel the
        // underlying Dexie transaction, so racing this write against a timer
        // would let a merely-queued write (e.g. behind an analytics scan in
        // another tab — the same contention as T5/REL-002) commit AFTER the
        // UI already told the learner to retry, producing a second
        // review_events/study_attempts row and a double FSRS replay for one
        // real answer. A queued write only delays the busy state; it can
        // never silently duplicate. MIRRORED in flashcard-session.tsx — keep
        // the two write paths in sync.
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
          // The taken hint stays visible with the feedback; it is cleared
          // when the learner advances (advanceAfterFeedback).
        } else if (nextState.status === "complete") {
          setUsedHint(null);
          setStatus("complete");
        } else {
          // Test mode advances straight to the next question: this question's
          // hint is spent and must not leak onto the next one.
          setUsedHint(null);
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
    setUsedHint(null);
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
      // The undone question is re-presented FRESH — including its hint offer.
      setUsedHint(null);
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

  // Session-result bookmarking (Phase 14 §18) — one shared snapshot, refreshed
  // after each write; never affected by undoing the last graded attempt.
  const { state: collections, refresh: refreshCollections } = useCollections();
  const knownEntryIds = useMemo(
    () => new Set(entries.map((entry) => entry.id)),
    [entries],
  );
  const bookmarkedEntryIds =
    collections.status === "ready"
      ? collections.snapshot.bookmarkedEntryIds
      : new Set<number>();
  const handleToggleBookmark = useCallback(
    async (entryId: number) => {
      await toggleBookmark(getSafwaDb(), entryId, knownEntryIds, Date.now());
      refreshCollections();
    },
    [knownEntryIds, refreshCollections],
  );

  if (!context || status === "error" || instance === "generation_failed") {
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
        <CardContent
          className="text-muted-foreground text-sm"
          data-testid="mc-empty"
        >
          {emptyMessage}
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
        bookmarkedEntryIds={bookmarkedEntryIds}
        onToggleBookmark={handleToggleBookmark}
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
      delivery={delivery}
      perQuestionLimitMs={session.config.perQuestionLimitMs}
      hints={availableHints(context, displayInstance)}
      usedHint={usedHint}
      onTakeHint={setUsedHint}
      answered={answered}
      canUndo={canUndo(session)}
      busy={busy}
      actionError={actionError}
      onAnswer={answer}
      onNext={advanceAfterFeedback}
      onUndo={undoLast}
      bookmarked={bookmarkedEntryIds.has(entry.id)}
      onToggleBookmark={() => handleToggleBookmark(entry.id)}
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
  hints,
  usedHint,
  onTakeHint,
  answered,
  canUndo: undoAvailable,
  busy,
  actionError,
  onAnswer,
  onNext,
  onUndo,
  bookmarked,
  onToggleBookmark,
}: {
  entry: LearnerEntry;
  instance: QuestionInstance;
  position: number;
  total: number;
  delivery: QuizDelivery;
  perQuestionLimitMs: number | null;
  hints: HintContent[];
  /** The hint taken for this question — owned by the RUNNER so it survives a
   * failed-write remount of this view (a retry must stay hinted). */
  usedHint: HintContent | null;
  onTakeHint: (hint: HintContent) => void;
  answered: AnsweredState | null;
  canUndo: boolean;
  busy: boolean;
  actionError: string | null;
  onAnswer: (
    selectedRef: AnswerReference | null,
    responseTimeMs: number,
    hint?: HintState,
  ) => void;
  onNext: () => void;
  onUndo: () => void;
  bookmarked: boolean;
  onToggleBookmark: () => Promise<void>;
}) {
  const shownAtRef = useRef<number>(0);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const hintDisplayRef = useRef<HTMLDivElement | null>(null);
  const isTimed = isTimedDelivery(delivery) && perQuestionLimitMs !== null;
  const [remainingMs, setRemainingMs] = useState<number>(
    perQuestionLimitMs ?? 0,
  );
  // Guards the one-shot timeout submit so a re-render can never fire it twice.
  const firedTimeout = useRef(false);

  /** The engine hint-state for the taken hint (undefined = fresh no-hint). */
  const hintStateOf = (hint: HintContent | null): HintState | undefined =>
    hint ? { used: true, type: hint.type } : undefined;

  useEffect(() => {
    shownAtRef.current = Date.now();
    // On a fresh question the first option is the natural focus start. When a
    // hint is already taken (a failed-write remount), the hint effect below
    // owns focus instead — guarded explicitly, not by effect ordering.
    if (!usedHint) firstOptionRef.current?.focus();
    // Mount-only: the hint effect handles later transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move focus to Next when feedback appears so keyboard users continue easily.
  useEffect(() => {
    if (answered) nextRef.current?.focus();
  }, [answered]);

  // Taking a hint replaces the (focused) hint buttons with the display card:
  // move focus onto the card so keyboard/SR users don't fall to <body>, and
  // so the revealed value is announced from the focus target.
  useEffect(() => {
    if (usedHint && !answered) hintDisplayRef.current?.focus();
  }, [usedHint, answered]);

  // Per-question countdown (timed mode). Stops once the question is answered.
  useEffect(() => {
    if (!isTimed || perQuestionLimitMs === null || answered) return;
    const tick = () => {
      // shownAtRef is stamped by the mount effect (declared first, so it has
      // already run); the Date.now fallback only guards a zero-stamped ref.
      const start = shownAtRef.current || Date.now();
      const remaining = perQuestionLimitMs - (Date.now() - start);
      setRemainingMs(Math.max(0, remaining));
      if (remaining <= 0 && !firedTimeout.current) {
        firedTimeout.current = true;
        // Submit a lapse: no selection, response time at the limit (the engine
        // derives the timeout solely from response time, counting it incorrect).
        // A taken hint is still recorded (hinted incorrect ⇒ Again, §4.4).
        onAnswer(null, perQuestionLimitMs, hintStateOf(usedHint));
      }
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
    // Re-arming the interval when the hint changes is harmless: the countdown
    // derives from shownAtRef, so recreation never resets the remaining time.
  }, [isTimed, perQuestionLimitMs, answered, onAnswer, usedHint]);

  const revealedForm = revealedFormField(instance);
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  return (
    <div
      className="space-y-4"
      data-testid="mc-quiz-session"
      data-entry-id={entry.id}
      data-skill-type={instance.skillType}
      data-prompt-field={instance.promptField}
      data-answer-field={instance.answerField}
      data-source-field={instance.sourceField ?? ""}
      data-delivery={delivery}
      data-hint-used={usedHint !== null}
      data-hint-type={usedHint?.type ?? ""}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm" aria-live="polite">
          Question {position} of {total}
        </p>
        <div className="flex items-center gap-3">
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
          <BookmarkToggle
            entryLabel={entry.meaning}
            bookmarked={bookmarked}
            onToggle={onToggleBookmark}
            size="sm"
          />
        </div>
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

      {hints.length > 0 && !answered ? (
        <div className="space-y-2" data-testid="hint-bar">
          {usedHint === null ? (
            <div
              role="group"
              aria-label="Hints"
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Hint
              </span>
              {hints.map((hint) => (
                <Button
                  key={hint.type}
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => onTakeHint(hint)}
                  data-testid={`hint-${hint.type}`}
                >
                  {hint.label}
                </Button>
              ))}
            </div>
          ) : (
            <Card
              ref={hintDisplayRef}
              tabIndex={-1}
              data-testid="hint-display"
              data-hint-type={usedHint.type}
              // Focus is moved here programmatically when the (focused) hint
              // button disappears — the indicator must stay VISIBLE for
              // keyboard users, so a plain :focus ring, not :focus-visible.
              className="focus:border-ring focus:ring-ring/50 outline-none focus:ring-3"
            >
              <CardContent className="flex items-center gap-3 py-3 text-sm">
                <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {usedHint.label}
                </span>
                {usedHint.isArabic ? (
                  <ArabicText className="text-xl">{usedHint.value}</ArabicText>
                ) : (
                  <span>{usedHint.value}</span>
                )}
                {/* Reduced credit is a learning rule (§4.4): a hinted correct
                    answer is rated Hard, so tell the learner up front. */}
                <span className="text-muted-foreground ml-auto text-xs">
                  Counts as partial credit
                </span>
              </CardContent>
            </Card>
          )}
        </div>
      ) : null}

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
              onAnswer(
                option.ref,
                Date.now() - shownAtRef.current,
                hintStateOf(usedHint),
              )
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
                form — never presented as an exact translation of that form.
                Shown only when the meaning itself is quiz-eligible: entry-level
                (bāb/root) components do not require meaning eligibility, and an
                ineligible value must never be taught (hard rule 2). */}
            {entry.quiz_eligibility.meaning ? (
              <p
                className="text-muted-foreground text-sm"
                data-testid="mc-base-meaning"
              >
                Base meaning: {entry.meaning}
              </p>
            ) : null}
            {revealedForm ? (
              <p
                className="text-muted-foreground text-sm"
                data-testid="mc-form-reveal"
              >
                Form: {formLabel(revealedForm)}
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
  bookmarkedEntryIds,
  onToggleBookmark,
}: {
  session: SessionState;
  entriesById: ReadonlyMap<number, LearnerEntry>;
  canUndo: boolean;
  busy: boolean;
  actionError: string | null;
  onUndo: () => void;
  onStudyAgain: () => void;
  bookmarkedEntryIds: ReadonlySet<number>;
  onToggleBookmark: (entryId: number) => Promise<void>;
}) {
  const summary = summarizeSession(session);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Test mode withheld per-question correctness inline; reveal it now (§4.4).
  const isTest = session.config.testMode;
  const outcomes: QuestionFeedback[] = isTest ? revealResults(session) : [];

  // The distinct entries studied, in first-seen order, for the bookmark
  // controls below (Phase 14 §18) — mirrors flashcard-session's SessionSummary.
  const studiedEntryIds: number[] = [];
  const seenEntryIds = new Set<number>();
  for (const attempt of session.attempts) {
    if (!seenEntryIds.has(attempt.entryId)) {
      seenEntryIds.add(attempt.entryId);
      studiedEntryIds.push(attempt.entryId);
    }
  }

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
                          the exact translation of the named form — and shown
                          only when the meaning is quiz-eligible (hard rule 2). */}
                      {answerEntry?.quiz_eligibility.meaning
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

        {studiedEntryIds.length > 0 ? (
          <div className="space-y-2" data-testid="summary-entries">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Review the words you studied
            </h3>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {studiedEntryIds.map((entryId) => {
                const entry = entriesById.get(entryId);
                if (!entry) return null;
                return (
                  <li
                    key={entryId}
                    data-entry-id={entryId}
                    className="flex items-center gap-2"
                  >
                    <Link
                      href={`/library/${entryId}`}
                      className="text-primary underline-offset-4 hover:underline"
                      data-testid="summary-entry-link"
                    >
                      {entry.meaning}
                    </Link>
                    <BookmarkToggle
                      entryLabel={entry.meaning}
                      bookmarked={bookmarkedEntryIds.has(entryId)}
                      onToggle={() => onToggleBookmark(entryId)}
                      size="sm"
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
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

/**
 * Shared loading / error boundary for the content-backed study session
 * components. Renders the loading skeleton or the retryable error card, or
 * null when content is ready (the caller then renders its session UI).
 */
export function ContentStateFallback({
  status,
  message,
  ariaLabel,
  retry,
}: {
  status: "loading" | "error";
  message?: string;
  ariaLabel: string;
  retry: () => void;
}) {
  if (status === "loading") {
    return (
      <div className="space-y-4" role="status" aria-label={ariaLabel}>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  return (
    <Card>
      <CardContent role="alert" className="space-y-3">
        <p className="text-destructive text-sm">{message}</p>
        <Button type="button" variant="outline" onClick={retry}>
          Retry loading content
        </Button>
      </CardContent>
    </Card>
  );
}
