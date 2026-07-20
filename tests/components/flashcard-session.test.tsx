import { readFileSync } from "node:fs";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
import { SOURCE_FORM_METADATA } from "@/lib/form-metadata";
import { DB_READ_TIMEOUT_MS } from "@/lib/with-timeout";
import type { SourceQuizFormField } from "@/modules/content/constants";
import type { AttemptRecord } from "@/modules/study-engine";
import type {
  PersistedAttempt,
  RecordAttemptContext,
} from "@/modules/study-session/persistence";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));

const readyState: ActiveContentState = {
  status: "ready",
  entries: built.learner.entries,
  releaseId: built.releaseId,
  contentVersion: built.learner.content_version,
  questionGeneratorVersion: built.learner.question_generator_version,
  entryCount: built.learner.entries.length,
  source: "cache",
};

vi.mock("@/components/content/use-active-content", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/content/use-active-content")
    >();
  return {
    ...original,
    useActiveContent: () => ({ state: readyState, retry: vi.fn() }),
  };
});

vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});

// Fresh guest: no durable profile at init (read-only), bound on first grade.
const peekDeviceProfile = vi.fn(async () => null);
vi.mock("@/modules/profile/device", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/device")>();
  return {
    ...original,
    peekDeviceProfile: (...args: Parameters<typeof peekDeviceProfile>) =>
      peekDeviceProfile(...args),
    getOrCreateDeviceProfile: vi.fn(async () => ({ deviceId: "dev-1" })),
  };
});

const ensureDurableGuestStateSpy = vi.fn(async () => ({ deviceId: "dev-1" }));

vi.mock("@/modules/profile/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/persistence")>();
  return {
    ...original,
    ensureDurableGuestState: (
      ...args: Parameters<typeof ensureDurableGuestStateSpy>
    ) => ensureDurableGuestStateSpy(...args),
  };
});

const recordGradedAttempt = vi.fn(
  async (
    _db: unknown,
    attempt: AttemptRecord,
    ctx: RecordAttemptContext,
  ): Promise<PersistedAttempt> => ({
    attemptId: attempt.id,
    componentKey: attempt.studyComponentId,
    eventId: ctx.eventId,
    deviceId: attempt.deviceId,
  }),
);
const undoGradedAttempt = vi.fn(async () => {});

vi.mock("@/modules/study-session/persistence", async (importActual) => {
  // Keep the REAL module surface (notably SupersededUndoError, which the UI uses
  // in an `instanceof` check), overriding only the two write functions.
  const actual =
    await importActual<typeof import("@/modules/study-session/persistence")>();
  return {
    ...actual,
    recordGradedAttempt: (...args: Parameters<typeof recordGradedAttempt>) =>
      recordGradedAttempt(...args),
    undoGradedAttempt: (...args: Parameters<typeof undoGradedAttempt>) =>
      undoGradedAttempt(...args),
  };
});

// The session-frozen effective clock (Phase 12): deterministic by default;
// individual tests override with mockResolvedValueOnce to prove the resolved
// zone reaches the persisted attempt.
const readEffectiveClock = vi.fn(
  async (): Promise<import("@/modules/study-engine").AttemptClock> => ({
    now: () => Date.now(),
    timezone: "UTC",
    timezoneSource: "browser_detected",
  }),
);

vi.mock("@/modules/profile/timezone", async (importActual) => {
  const actual =
    await importActual<typeof import("@/modules/profile/timezone")>();
  return {
    ...actual,
    readEffectiveClock: (...args: Parameters<typeof readEffectiveClock>) =>
      readEffectiveClock(...args),
  };
});

// Session-result bookmarking (Phase 14 §18): the snapshot always reads back
// empty (no pre-existing bookmarks), and the write is a spy — isolates the
// summary-screen wiring from the Dexie/fake-indexeddb layer already covered
// by tests/collections/persistence.test.ts.
const toggleBookmarkSpy: Mock<
  typeof import("@/modules/collections/persistence").toggleBookmark
> = vi.fn(async () => true);
vi.mock("@/modules/collections/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/collections/persistence")>();
  return {
    ...original,
    readCollections: vi.fn(async () => ({ bookmarks: [], lists: [] })),
    toggleBookmark: (...args: Parameters<typeof toggleBookmarkSpy>) =>
      toggleBookmarkSpy(...args),
  };
});

import { FlashcardSession } from "@/components/study/flashcard-session";
import { SupersededUndoError } from "@/modules/study-session/persistence";

afterEach(() => {
  recordGradedAttempt.mockClear();
  undoGradedAttempt.mockClear();
  ensureDurableGuestStateSpy.mockClear();
  readEffectiveClock.mockClear();
  peekDeviceProfile.mockClear();
  toggleBookmarkSpy.mockClear();
  vi.useRealTimers();
});

/** Wait for the first card, returning the flashcard button element. */
async function waitForCard(): Promise<HTMLElement> {
  return waitFor(() => screen.getByTestId("flashcard"), { timeout: 4000 });
}

describe("FlashcardSession", () => {
  it("auto-starts a session and shows the first card without a start click", async () => {
    render(<FlashcardSession />);
    const card = await waitForCard();
    expect(card).toBeInTheDocument();
    expect(screen.getByText(/Card 1 of/)).toBeInTheDocument();
  });

  it("stamps flashcard attempts from the session-frozen effective clock (§10.5/§10.6)", async () => {
    // 2026-07-17T20:00Z is already 2026-07-18 05:00 in Asia/Tokyo (+09:00) —
    // the graded card's immutable event-time fields must follow the RESOLVED
    // user-setting zone, not UTC and not the test environment's zone.
    const fixedNowMs = Date.UTC(2026, 6, 17, 20, 0, 0);
    readEffectiveClock.mockResolvedValueOnce({
      now: () => fixedNowMs,
      timezone: "Asia/Tokyo",
      timezoneSource: "user_setting",
    });

    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();
    await user.click(card); // flip to reveal
    await user.click(screen.getByTestId("rate-know"));

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    expect(readEffectiveClock).toHaveBeenCalledTimes(1); // frozen per mount
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.timezoneAtEvent).toBe("Asia/Tokyo");
    expect(attempt.timezoneSource).toBe("user_setting");
    expect(attempt.localDateAtEvent).toBe("2026-07-18");
    expect(attempt.utcOffsetMinutesAtEvent).toBe(540);
    expect(attempt.occurredAtUtc).toBe(new Date(fixedNowMs).toISOString());
  });

  it("gates rating until the answer is revealed, then advances on 'I know'", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();

    // Rating is disabled before the card is flipped.
    expect(screen.getByTestId("rate-know")).toBeDisabled();
    expect(screen.getByTestId("rate-dont-know")).toBeDisabled();

    // Flip to reveal, then rate.
    await user.click(card);
    expect(screen.getByTestId("rate-know")).toBeEnabled();
    await user.click(screen.getByTestId("rate-know"));

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.mode).toBe("flashcard");
    expect(attempt.isCorrect).toBe(true);
    // Advanced to the next card.
    await waitFor(() =>
      expect(screen.getByText(/Card 2 of/)).toBeInTheDocument(),
    );
  });

  it("re-queues a wrong card in-session ('I don't know')", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();
    const totalBefore = Number(
      /Card 1 of (\d+)/.exec(screen.getByText(/Card 1 of/).textContent!)![1],
    );

    await user.click(card);
    await user.click(screen.getByTestId("rate-dont-know"));

    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.isCorrect).toBe(false);
    // A wrong first attempt adds one reinforcement item to the plan.
    await waitFor(() => {
      const total = Number(
        /Card 2 of (\d+)/.exec(screen.getByText(/Card 2 of/).textContent!)![1],
      );
      expect(total).toBe(totalBefore + 1);
    });
  });

  it("shows one bookmark toggle per distinct studied entry, and undo does not undo a bookmark (§18)", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    let card = await waitForCard();

    // Fail the first card (re-queues it once) so the dedup logic below is
    // genuinely exercised, not vacuously true.
    await user.click(card);
    await user.click(screen.getByTestId("rate-dont-know"));

    for (let i = 0; i < 60; i++) {
      if (screen.queryByTestId("session-summary")) break;
      card = screen.queryByTestId("flashcard") as HTMLElement;
      if (!card) break;
      await user.click(card);
      await user.click(screen.getByTestId("rate-know"));
    }

    const summary = await screen.findByTestId("session-summary", undefined, {
      timeout: 4000,
    });
    const summaryEntries = within(summary).getByTestId("summary-entries");
    const links = within(summaryEntries).getAllByTestId("summary-entry-link");
    const toggles = within(summaryEntries).getAllByTestId("bookmark-toggle");
    // Exactly one row (and one toggle) per distinct entry — never one per
    // attempt/reinforcement.
    expect(toggles.length).toBe(links.length);
    expect(new Set(links.map((link) => link.getAttribute("href"))).size).toBe(
      links.length,
    );

    const firstRow = summaryEntries.querySelector("li[data-entry-id]")!;
    const entryId = Number(firstRow.getAttribute("data-entry-id"));
    const toggle = within(firstRow as HTMLElement).getByTestId(
      "bookmark-toggle",
    );
    expect(toggle).toHaveAttribute("data-bookmarked", "false");

    await user.click(toggle);
    await waitFor(() => expect(toggleBookmarkSpy).toHaveBeenCalledTimes(1));
    expect(toggleBookmarkSpy.mock.calls[0][1]).toBe(entryId);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("data-bookmarked", "true"),
    );

    // Undoing the last graded card must not touch the bookmark: the bookmark
    // write is a separate user action from study-history undo (§18).
    const undoButton = within(summary).getByTestId("undo");
    await user.click(undoButton);
    await waitFor(() => expect(undoGradedAttempt).toHaveBeenCalledTimes(1));
    expect(toggleBookmarkSpy).toHaveBeenCalledTimes(1);
    // The undo genuinely returned to an active card (summary unmounted),
    // proving the previous assertion was against the live summary screen.
    expect(screen.queryByTestId("session-summary")).toBeNull();
  });

  it("undoes exactly the last action once", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();

    // Undo is unavailable before any action.
    expect(screen.getByTestId("undo")).toBeDisabled();

    await user.click(card);
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 2 of/)).toBeInTheDocument(),
    );

    // Undo is now available; using it reverses the persisted attempt and
    // returns to card 1.
    const undoButton = screen.getByTestId("undo");
    expect(undoButton).toBeEnabled();
    await user.click(undoButton);

    await waitFor(() => expect(undoGradedAttempt).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/Card 1 of/)).toBeInTheDocument(),
    );
    // Single-step: no second undo.
    await waitFor(() => expect(screen.getByTestId("undo")).toBeDisabled());
  });

  it("surfaces a retryable error and does not advance when persistence fails", async () => {
    const user = userEvent.setup();
    recordGradedAttempt.mockImplementationOnce(async () => {
      throw new Error("indexeddb unavailable");
    });
    render(<FlashcardSession />);
    const card = await waitForCard();

    await user.click(card);
    await user.click(screen.getByTestId("rate-know"));

    // The error is announced and the session stays on card 1.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i),
    );
    expect(screen.getByText(/Card 1 of/)).toBeInTheDocument();

    // The failed first grade still asked the adapter to bind the profile
    // atomically (bindProfile passed), so nothing was committed out of band.
    expect(recordGradedAttempt.mock.calls[0][2].bindProfile).toBeDefined();

    // A retry (persistence now succeeds) advances normally, and — because the
    // first write failed before binding was latched — the retry still passes
    // bindProfile so the device profile is created with the same write.
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 2 of/)).toBeInTheDocument(),
    );
    expect(recordGradedAttempt.mock.calls[1][2].bindProfile).toBeDefined();

    // Once bound, a later grade no longer re-binds.
    await user.click(screen.getByTestId("flashcard"));
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 3 of/)).toBeInTheDocument(),
    );
    expect(recordGradedAttempt.mock.calls[2][2].bindProfile).toBeUndefined();
  });

  it("requests durable storage after every successful grade (retries denials)", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();

    await user.click(card);
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 2 of/)).toBeInTheDocument(),
    );
    expect(ensureDurableGuestStateSpy).toHaveBeenCalledTimes(1);

    // Grading the next card requests durable storage again — a previously
    // denied persist request must get another chance on later writes.
    await user.click(screen.getByTestId("flashcard"));
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 3 of/)).toBeInTheDocument(),
    );
    expect(ensureDurableGuestStateSpy).toHaveBeenCalledTimes(2);
  });

  it("retires the undo when it is rejected as superseded (no phantom re-undo)", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();

    // Grade card 1 so an undo becomes available.
    await user.click(card);
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 2 of/)).toBeInTheDocument(),
    );
    const undoButton = screen.getByTestId("undo");
    expect(undoButton).toBeEnabled();

    // The reversal is rejected because a later review superseded the event.
    undoGradedAttempt.mockRejectedValueOnce(
      new SupersededUndoError("superseded"),
    );
    await user.click(undoButton);

    // A clear, non-retry message; the session did NOT revert (still card 2)...
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /reviewed again elsewhere/i,
      ),
    );
    expect(screen.getByText(/Card 2 of/)).toBeInTheDocument();
    // ...and the undo is retired so a second click cannot fire a phantom undo.
    await waitFor(() => expect(screen.getByTestId("undo")).toBeDisabled());
    await user.click(screen.getByTestId("undo"));
    expect(screen.getByText(/Card 2 of/)).toBeInTheDocument();
    expect(undoGradedAttempt).toHaveBeenCalledTimes(1);
  });

  it("English→Arabic cards name the target form before the flip and label the base meaning", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    await waitForCard();

    await user.click(screen.getByRole("button", { name: "English → Arabic" }));
    const sessionEl = await waitFor(() => {
      const el = screen.getByTestId("flashcard-session");
      if (el.getAttribute("data-prompt-field") !== "meaning") {
        throw new Error("not a recall card yet");
      }
      return el;
    });
    const card = within(screen.getByTestId("flashcard"));
    const answerField = sessionEl.getAttribute(
      "data-answer-field",
    ) as SourceQuizFormField;

    // BEFORE flipping: the English side is labelled as the base meaning and
    // names the target form (from shared metadata) — the learner always knows
    // which Arabic form to recall.
    expect(card.getByText("Base meaning")).toBeInTheDocument();
    const detail = card.getByTestId("flashcard-face-detail");
    expect(detail.textContent).toBe(
      `Target form: ${SOURCE_FORM_METADATA[answerField].label}`,
    );
    // The visible front face (not the hidden answer face) carries the label.
    expect(detail.closest("[aria-hidden='true']")).toBeNull();

    // The front shows the entry's verbatim base meaning from the built release
    // (programmatic lookup by id — never hand-typed values).
    const entryId = Number(sessionEl.getAttribute("data-entry-id"));
    const entry = built.learner.entries.find(
      (candidate) => candidate.id === entryId,
    )!;
    expect(card.getByText(entry.meaning)).toBeInTheDocument();
  });

  it("Arabic→English cards label the English answer side as the base meaning", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    await waitForCard();

    await user.click(screen.getByRole("button", { name: "Arabic → English" }));
    const sessionEl = await waitFor(() => {
      const el = screen.getByTestId("flashcard-session");
      if (el.getAttribute("data-answer-field") !== "meaning") {
        throw new Error("not a recognition card yet");
      }
      return el;
    });
    const card = within(screen.getByTestId("flashcard"));
    const promptField = sessionEl.getAttribute(
      "data-prompt-field",
    ) as SourceQuizFormField;

    // The Arabic front is captioned with the form's shared-metadata label; the
    // English side says "Base meaning" (not "Meaning"/"Translation") and stays
    // out of the accessibility tree until the card is flipped.
    expect(
      card.getByText(SOURCE_FORM_METADATA[promptField].label),
    ).toBeInTheDocument();
    expect(
      card.getByText("Base meaning").closest("[aria-hidden='true']"),
    ).not.toBeNull();
    // The answer face keeps the form context alongside the base meaning, so
    // the reveal shows BOTH (base meaning + form) — hidden until flipped.
    const detail = card.getByTestId("flashcard-face-detail");
    expect(detail.textContent).toBe(
      `Form: ${SOURCE_FORM_METADATA[promptField].label}`,
    );
    expect(detail.closest("[aria-hidden='true']")).not.toBeNull();

    await user.click(screen.getByTestId("flashcard"));
    expect(
      card.getByText("Base meaning").closest("[aria-hidden='true']"),
    ).toBeNull();
    expect(
      card.getByTestId("flashcard-face-detail").closest("[aria-hidden='true']"),
    ).toBeNull();
  });

  it("rates via the keyboard arrow keys once revealed", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();
    await user.click(card);
    card.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    const [, attempt] = recordGradedAttempt.mock.calls[0];
    expect(attempt.isCorrect).toBe(true);
  });

  it("grades via the touch-swipe handler once revealed (rightward = 'I know')", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();
    await user.click(card); // reveal
    const touchTarget = screen.getByTestId("flashcard-touch");
    // A rightward swipe past the threshold grades "I know". (This is the
    // lower-level handler check; the mobile E2E drives real browser touch.)
    fireEvent.touchStart(touchTarget, {
      touches: [{ identifier: 1, clientX: 20, clientY: 100 }],
      changedTouches: [{ identifier: 1, clientX: 20, clientY: 100 }],
    });
    fireEvent.touchEnd(touchTarget, {
      changedTouches: [{ identifier: 1, clientX: 220, clientY: 100 }],
    });
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
    expect(recordGradedAttempt.mock.calls[0][1].isCorrect).toBe(true);
  });

  it("does not grade on a tiny swipe below the threshold", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();
    await user.click(card);
    const touchTarget = screen.getByTestId("flashcard-touch");
    fireEvent.touchStart(touchTarget, {
      touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(touchTarget, {
      changedTouches: [{ identifier: 1, clientX: 110, clientY: 100 }],
    });
    // 10px < 48px threshold: treated as a tap, not a grade.
    expect(recordGradedAttempt).not.toHaveBeenCalled();
  });

  it("does not grade on a diagonal/vertical drift (page scroll), only horizontal swipes", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();
    await user.click(card);
    const touchTarget = screen.getByTestId("flashcard-touch");
    // dx=100 (past threshold) but dy=200 dominates: a scroll, not a grade.
    fireEvent.touchStart(touchTarget, {
      touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(touchTarget, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 300 }],
    });
    expect(recordGradedAttempt).not.toHaveBeenCalled();

    // A predominantly-horizontal swipe still grades.
    fireEvent.touchStart(touchTarget, {
      touches: [{ identifier: 2, clientX: 20, clientY: 100 }],
      changedTouches: [{ identifier: 2, clientX: 20, clientY: 100 }],
    });
    fireEvent.touchEnd(touchTarget, {
      changedTouches: [{ identifier: 2, clientX: 200, clientY: 130 }],
    });
    await waitFor(() => expect(recordGradedAttempt).toHaveBeenCalledTimes(1));
  });

  it("does not grade a multi-touch (pinch) gesture", async () => {
    const user = userEvent.setup();
    render(<FlashcardSession />);
    const card = await waitForCard();
    await user.click(card);
    const touchTarget = screen.getByTestId("flashcard-touch");
    // Two fingers down cancels swipe tracking.
    fireEvent.touchStart(touchTarget, {
      touches: [
        { identifier: 1, clientX: 100, clientY: 100 },
        { identifier: 2, clientX: 200, clientY: 100 },
      ],
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(touchTarget, {
      changedTouches: [{ identifier: 1, clientX: 300, clientY: 100 }],
    });
    expect(recordGradedAttempt).not.toHaveBeenCalled();
  });

  it("keeps the durable device id across an undo + re-grade (concurrent bind)", async () => {
    const user = userEvent.setup();
    // The adapter reports a DIFFERENT committed device id than the provisional
    // one (as if another tab bound the profile first).
    recordGradedAttempt.mockImplementationOnce(async (_db, attempt, ctx) => ({
      attemptId: attempt.id,
      componentKey: attempt.studyComponentId,
      eventId: ctx.eventId,
      deviceId: "committed-A",
    }));
    render(<FlashcardSession />);
    const card = await waitForCard();

    await user.click(card);
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 2 of/)).toBeInTheDocument(),
    );

    // Undo back to card 1, then re-grade: the new attempt must carry the
    // committed id, not the resurrected provisional one from the undo snapshot.
    await user.click(screen.getByTestId("undo"));
    await waitFor(() =>
      expect(screen.getByText(/Card 1 of/)).toBeInTheDocument(),
    );
    const cardAgain = screen.getByTestId("flashcard");
    await user.click(cardAgain);
    await user.click(screen.getByTestId("rate-know"));
    await waitFor(() =>
      expect(screen.getByText(/Card 2 of/)).toBeInTheDocument(),
    );

    const lastCall =
      recordGradedAttempt.mock.calls[recordGradedAttempt.mock.calls.length - 1];
    expect(lastCall[1].deviceId).toBe("committed-A");
  });

  it("never artificially times out a slow-but-eventually-successful grading write (P1 regression guard)", async () => {
    // Regression guard: the grading write must NEVER be raced against a
    // timer (Promise.race cannot cancel the underlying Dexie transaction —
    // a "timed out" write can still commit later, duplicating the review
    // row once the learner retries). This proves a write that is merely
    // slow/queued — even well past the OLD, removed 15s DB_WRITE_TIMEOUT_MS
    // — is always awaited to its real outcome, never abandoned mid-flight.
    vi.useFakeTimers();
    let resolveWrite: (() => void) | undefined;
    recordGradedAttempt.mockImplementationOnce(
      (_db, attempt, ctx) =>
        new Promise<PersistedAttempt>((resolve) => {
          resolveWrite = () =>
            resolve({
              attemptId: attempt.id,
              componentKey: attempt.studyComponentId,
              eventId: ctx.eventId,
              deviceId: attempt.deviceId,
            });
        }),
    );
    render(<FlashcardSession />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByTestId("flashcard"));
    fireEvent.click(screen.getByTestId("rate-know"));

    // No timer exists on this path at all today (that is the fix) — this
    // advance is a tripwire against a FUTURE re-wrap, not an exercise of a
    // currently-live timeout: it would only matter if grading were ever
    // raced against a timer shorter than this again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    // Still queued: no error, no advance — and critically, no artificial
    // failure was ever surfaced while the real write was still in flight.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Card 1 of/)).toBeInTheDocument();

    // The write finally lands, successfully.
    resolveWrite?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Card 2 of/)).toBeInTheDocument();
  });

  it("bounds a hung session-init read, and a late resolution never revives it (REL-P101)", async () => {
    // A blocked IndexedDB open (e.g. another tab mid schema-upgrade) must
    // surface the recoverable error within DB_READ_TIMEOUT_MS — and once
    // shown, that error is TERMINAL: the connection clearing moments later
    // must never silently flip the screen back to a live session with no
    // user action (MIRRORED in mc-quiz-session.test.tsx).
    vi.useFakeTimers();
    let resolveClock: (() => void) | undefined;
    readEffectiveClock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClock = () =>
            resolve({
              now: () => Date.now(),
              timezone: "UTC",
              timezoneSource: "browser_detected",
            });
        }),
    );
    render(<FlashcardSession />);
    // Flush the (fast) useSessionDefaults settle first so the runner mounts
    // and starts its OWN session-init read before advancing its budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DB_READ_TIMEOUT_MS + 1);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);

    // The blocked connection finally clears — but the timeout already fired.
    resolveClock?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);
    expect(screen.queryByTestId("flashcard-session")).toBeNull();
  });

  it("makes the timeout terminal regardless of WHICH init read hangs (checkpoint-agnostic, REL-P101)", async () => {
    // The guard is one shared `cancelled` flag checked before every side
    // effect, not a special case for the first await — prove a hang further
    // into initialisation (peekDeviceProfile) is bounded the same way
    // (MIRRORED in mc-quiz-session.test.tsx).
    vi.useFakeTimers();
    let resolveProfile: (() => void) | undefined;
    peekDeviceProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfile = () => resolve(null);
        }),
    );
    render(<FlashcardSession />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DB_READ_TIMEOUT_MS + 1);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);

    resolveProfile?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start/i);
    expect(screen.queryByTestId("flashcard-session")).toBeNull();
  });
});
