"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import { Flashcard } from "@/components/flashcard";
import {
  FieldValue,
  FIELD_LABELS,
  browserClock,
} from "@/components/study/study-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useReducedMotion } from "@/lib/preferences/use-reduced-motion";
import { uuidv7 } from "@/lib/uuid";
import { getSafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { newDeviceProfile, peekDeviceProfile } from "@/modules/profile/device";
import { ensureDurableGuestState } from "@/modules/profile/persistence";
import {
  createQuestionContext,
  type QuestionContext,
  type QuestionInstance,
} from "@/modules/study-engine/generator";
import {
  canUndo,
  createSession,
  currentQuestion,
  submitAnswer,
  summarizeSession,
  undo,
  type SessionState,
} from "@/modules/study-engine/session";
import type { FlashcardSelfGrade } from "@/modules/study-engine/correctness";
import {
  buildFlashcardPlan,
  DEFAULT_FLASHCARD_CONFIG,
  type FlashcardConfig,
  type FlashcardDirectionChoice,
  type FlashcardFieldChoice,
} from "@/modules/study-session/flashcards";
import {
  recordGradedAttempt,
  SupersededUndoError,
  undoGradedAttempt,
  type PersistedAttempt,
} from "@/modules/study-session/persistence";

const DIRECTION_OPTIONS: { value: FlashcardDirectionChoice; label: string }[] =
  [
    { value: "random", label: "Both directions" },
    { value: "arabic_to_english", label: "Arabic → English" },
    { value: "english_to_arabic", label: "English → Arabic" },
  ];

const FIELD_OPTIONS: { value: FlashcardFieldChoice; label: string }[] = [
  { value: "random", label: "Any eligible form" },
  { value: "madi", label: FIELD_LABELS.madi },
  { value: "mudari", label: FIELD_LABELS.mudari },
  { value: "masdar", label: FIELD_LABELS.masdar },
  { value: "ism_fail", label: FIELD_LABELS.ism_fail },
  { value: "amr", label: FIELD_LABELS.amr },
  { value: "nahi", label: FIELD_LABELS.nahi },
];

const SWIPE_THRESHOLD_PX = 48;

/** Top-level: loads content, hosts the options bar, and mounts the runner. */
export function FlashcardSession() {
  const { state, retry } = useActiveContent();
  const [config, setConfig] = useState<FlashcardConfig>(
    DEFAULT_FLASHCARD_CONFIG,
  );
  // Bumping this token remounts the runner, starting a fresh session (used by
  // "Study again" and by any options change).
  const [sessionToken, setSessionToken] = useState(0);

  if (state.status === "loading") {
    return (
      <div className="space-y-4" role="status" aria-label="Loading flashcards">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <span className="sr-only">Loading flashcards…</span>
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

  const updateConfig = (next: Partial<FlashcardConfig>) => {
    setConfig((current) => ({ ...current, ...next }));
    setSessionToken((token) => token + 1);
  };

  return (
    <div className="space-y-5">
      <OptionsBar config={config} onChange={updateConfig} />
      <FlashcardRunner
        key={`${config.direction}|${config.field}|${sessionToken}`}
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
  config: FlashcardConfig;
  onChange: (next: Partial<FlashcardConfig>) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-end gap-4"
      data-testid="flashcard-options"
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
          onChange={(event) =>
            onChange({ field: event.target.value as FlashcardFieldChoice })
          }
        >
          {FIELD_OPTIONS.map((option) => (
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

function FlashcardRunner({
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
  config: FlashcardConfig;
  onStudyAgain: () => void;
}) {
  const [status, setStatus] = useState<RunnerStatus>("initialising");
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  // Transient, recoverable error from a failed grade/undo persistence write.
  const [actionError, setActionError] = useState<string | null>(null);

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

  // The last persisted action, for single-step undo. A ref (not state) because
  // undo reads it synchronously inside a handler and it must never be stale.
  const lastPersisted = useRef<PersistedAttempt | null>(null);
  // Whether the durable device identity has been bound + persist requested.
  // Deferred to the first graded attempt (first progress) so merely viewing the
  // route neither writes a profile row nor prompts for storage — Phase-5 lazy
  // identity contract + the ≤2-tap path (A1).
  const deviceBound = useRef(false);
  // When this session began (epoch ms) — recorded as the session row's start so
  // it reflects session-open time, not first-grade time.
  const sessionStartedAt = useRef<number>(0);

  // Build the session once per mount (a fresh mount == a fresh session).
  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getSafwaDb();
        sessionStartedAt.current = Date.now();
        // READ-ONLY at init: reuse an existing device id if the guest already
        // has durable state, else a provisional in-memory id that never touches
        // disk. The real, persisted id is bound on the first grade (see
        // `grade`), which also fires the storage-persist request.
        const existing = await peekDeviceProfile(db);
        if (existing) deviceBound.current = true;
        const deviceId = existing?.deviceId ?? uuidv7();
        const seed = uuidv7();
        const plan = buildFlashcardPlan(entries, config, seed);
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
            config: { mode: "flashcard" },
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

  const grade = useCallback(
    async (selfGrade: FlashcardSelfGrade, responseTimeMs: number) => {
      if (!session || !context || !instance || busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const db = getSafwaDb();
        const clock = browserClock();
        const result = submitAnswer(session, context, {
          attemptId: uuidv7(),
          questionInstanceId: instance.questionInstanceId,
          selfGrade,
          responseTimeMs: Math.max(0, responseTimeMs),
          clock,
        });
        // On FIRST progress, hand the adapter a provisional profile to create
        // atomically WITH the attempt/event write, so a failed grade leaves no
        // orphaned identity (the profile is not committed in a separate
        // transaction). The adapter returns the effective (committed) device id.
        const bindNow = !deviceBound.current;
        const persisted = await recordGradedAttempt(db, result.attempt, {
          eventId: uuidv7(),
          now: clock.now(),
          sessionStartedAt: sessionStartedAt.current || clock.now(),
          bindProfile: bindNow
            ? newDeviceProfile(session.deviceId, clock.now())
            : undefined,
        });
        // The first durable write has landed: latch the binding and reconcile
        // the session's device id with the committed one (a concurrent tab may
        // have already bound a different id). BOTH the current state and its undo
        // snapshot are reconciled, so undoing then re-grading cannot resurrect a
        // provisional id under the durable profile.
        if (bindNow) deviceBound.current = true;
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
        // Request durable storage after EVERY successful durable write (not just
        // the first): the helper coalesces, no-ops once granted, and — per the
        // Phase-5 contract — RETRIES a previously denied request on later writes,
        // since engagement heuristics can grant it later. Non-blocking (it may
        // prompt).
        void ensureDurableGuestState(db).catch(() => {});
        lastPersisted.current = persisted;
        setSession(nextState);
        if (nextState.status === "complete") setStatus("complete");
      } catch {
        // The write is atomic (Dexie transaction) — attempt, event AND the
        // first-progress profile commit together or not at all — so nothing was
        // half-saved and the card has not advanced; surface a retryable error.
        setActionError("Couldn't save that. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [session, context, instance, busy],
  );

  const undoLast = useCallback(async () => {
    if (!session || busy || !canUndo(session)) return;
    const persisted = lastPersisted.current;
    setBusy(true);
    setActionError(null);
    try {
      if (persisted) {
        await undoGradedAttempt(getSafwaDb(), persisted, Date.now());
      }
      // Only advance the engine state once the DB reversal succeeded, so a
      // failed undo leaves attempt, event and UI consistent.
      lastPersisted.current = null;
      setSession(undo(session));
      setStatus("active");
    } catch (error) {
      // A superseded undo can never succeed (a later review depends on it), so
      // RETIRE it: drop the undo snapshot so `canUndo` is false and the button
      // disables — otherwise a second click would perform a phantom engine-only
      // undo that diverges from the durable store. Other failures are transient
      // and retryable (the snapshot is kept).
      if (error instanceof SupersededUndoError) {
        lastPersisted.current = null;
        setSession({ ...session, previous: null });
        setActionError(
          "This card was reviewed again elsewhere and can no longer be undone.",
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
          Flashcards could not start. Please reload the page.
        </CardContent>
      </Card>
    );
  }

  if (status === "initialising") {
    return (
      <div role="status" aria-label="Preparing session">
        <Skeleton className="h-64 w-full rounded-xl" />
        <span className="sr-only">Preparing your flashcards…</span>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          No eligible flashcards match these options. Try a different form or
          direction.
        </CardContent>
      </Card>
    );
  }

  if (status === "complete" && session) {
    return (
      <SessionSummary
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

  if (!session || !instance) return null;

  const entry = context.entriesById.get(instance.entryId)!;
  return (
    <CardView
      key={instance.questionInstanceId}
      entry={entry}
      instance={instance}
      position={session.currentIndex + 1}
      total={session.plan.length}
      canUndo={canUndo(session)}
      busy={busy}
      actionError={actionError}
      onGrade={grade}
      onUndo={undoLast}
    />
  );
}

/**
 * One card's view. Owns the per-card flip/reveal state — reset naturally by the
 * `key` on the question id, so no state-resetting effect is needed. Rating is
 * only possible once the answer has been revealed.
 */
function CardView({
  entry,
  instance,
  position,
  total,
  canUndo: undoAvailable,
  busy,
  actionError,
  onGrade,
  onUndo,
}: {
  entry: LearnerEntry;
  instance: QuestionInstance;
  position: number;
  total: number;
  canUndo: boolean;
  busy: boolean;
  actionError: string | null;
  onGrade: (grade: FlashcardSelfGrade, responseTimeMs: number) => void;
  onUndo: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [flipped, setFlipped] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Set when the card mounts (in an effect — Date.now must not run in render).
  const shownAtRef = useRef<number>(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The tracked swipe: start coordinates + the touch identifier, or null when no
  // single-finger gesture is in progress.
  const swipeStart = useRef<{ x: number; y: number; id: number } | null>(null);

  // Stamp the shown time and focus the card on mount so keyboard users can flip
  // immediately.
  useEffect(() => {
    shownAtRef.current = Date.now();
    cardRef.current?.querySelector("button")?.focus();
  }, []);

  const flip = () =>
    setFlipped((current) => {
      const next = !current;
      if (next) setRevealed(true);
      return next;
    });

  const rate = (grade: FlashcardSelfGrade) => {
    if (!revealed || busy) return;
    onGrade(grade, Date.now() - shownAtRef.current);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      rate("know");
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      rate("dont_know");
    }
  };

  const onTouchStart = (event: React.TouchEvent) => {
    // Only a single-finger gesture can be a grading swipe; a second finger
    // (pinch/zoom) cancels tracking so it can never grade.
    if (event.touches.length !== 1) {
      swipeStart.current = null;
      return;
    }
    const touch = event.changedTouches[0];
    swipeStart.current = touch
      ? { x: touch.clientX, y: touch.clientY, id: touch.identifier }
      : null;
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (start === null) return;
    // Match the same finger that started the gesture.
    const touch = Array.from(event.changedTouches).find(
      (candidate) => candidate.identifier === start.id,
    );
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Grade only on a deliberate, predominantly-horizontal swipe — a vertical or
    // diagonal drift (page scroll) never counts, so it cannot record an
    // accidental answer.
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) {
      return;
    }
    rate(dx > 0 ? "know" : "dont_know");
  };
  const onTouchCancel = () => {
    swipeStart.current = null;
  };

  return (
    <div
      className="space-y-4"
      data-testid="flashcard-session"
      data-entry-id={entry.id}
      data-prompt-field={instance.promptField}
      data-answer-field={instance.answerField}
      onKeyDown={onKeyDown}
    >
      <p className="text-muted-foreground text-sm" aria-live="polite">
        Card {position} of {total}
      </p>

      <div
        ref={cardRef}
        data-testid="flashcard-touch"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <Flashcard
          front={<FieldValue entry={entry} field={instance.promptField} />}
          back={<FieldValue entry={entry} field={instance.answerField} />}
          frontCaption={FIELD_LABELS[instance.promptField]}
          backCaption={FIELD_LABELS[instance.answerField]}
          flipped={flipped}
          onFlip={flip}
          reducedMotion={reducedMotion}
        />
      </div>

      <p className="text-muted-foreground text-center text-xs">
        Tap the card or press Space to {flipped ? "hide" : "reveal"} the answer.
      </p>

      {actionError ? (
        <p role="alert" className="text-destructive text-center text-sm">
          {actionError}
        </p>
      ) : null}

      <div className="flex items-center justify-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 min-w-32"
          disabled={!revealed || busy}
          onClick={() => rate("dont_know")}
          data-testid="rate-dont-know"
        >
          I don&apos;t know
        </Button>
        <Button
          type="button"
          className="min-h-11 min-w-32"
          disabled={!revealed || busy}
          onClick={() => rate("know")}
          data-testid="rate-know"
        >
          I know
        </Button>
      </div>

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
        {revealed ? (
          <Button asChild variant="link" className="min-h-11">
            <Link href={`/library/${entry.id}`} data-testid="entry-detail-link">
              View full entry
            </Link>
          </Button>
        ) : (
          <span aria-hidden className="text-xs">
            &nbsp;
          </span>
        )}
      </div>
    </div>
  );
}

function SessionSummary({
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

  // Move focus to the summary heading on completion so keyboard/SR users are
  // not stranded on the removed card.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // The distinct entries studied, in first-seen order, for detail links.
  const studiedEntryIds: number[] = [];
  const seen = new Set<number>();
  for (const attempt of session.attempts) {
    if (!seen.has(attempt.entryId)) {
      seen.add(attempt.entryId);
      studiedEntryIds.push(attempt.entryId);
    }
  }

  return (
    <Card data-testid="session-summary">
      <CardContent className="space-y-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          Session complete
        </h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Cards seen" value={summary.componentsSeen} />
          <Stat label="Knew first time" value={summary.firstAttemptCorrect} />
          <Stat label="Recovered in session" value={summary.recovered} />
          {/* Wrong on the first try and NOT recovered this session. This is not
              the count of scheduled reviews — recovered cards also return soon
              (their sole event stays `again`); it names unrecovered errors. */}
          <Stat label="Not recovered" value={summary.repeatedIncorrect} />
        </dl>

        {actionError ? (
          <p role="alert" className="text-destructive text-sm">
            {actionError}
          </p>
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
              Undo last card
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
                  <li key={entryId}>
                    <Link
                      href={`/library/${entryId}`}
                      className="text-primary underline-offset-4 hover:underline"
                      data-testid="summary-entry-link"
                    >
                      {entry.meaning}
                    </Link>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
