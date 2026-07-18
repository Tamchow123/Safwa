import { readFileSync } from "node:fs";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
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

vi.mock("@/modules/profile/device", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/device")>();
  return {
    ...original,
    // Fresh guest: no durable profile at init (read-only), bound on first grade.
    peekDeviceProfile: vi.fn(async () => null),
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

import { FlashcardSession } from "@/components/study/flashcard-session";
import { SupersededUndoError } from "@/modules/study-session/persistence";

afterEach(() => {
  recordGradedAttempt.mockClear();
  undoGradedAttempt.mockClear();
  ensureDurableGuestStateSpy.mockClear();
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
});
