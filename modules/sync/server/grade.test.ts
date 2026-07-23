import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Scoped mock: this test loads the real release via the server-only manifest
// loader (see release.test.ts / tests/env/server.test.ts for rationale).
vi.mock("server-only", () => ({}));

import type { AnswerReference } from "@/modules/content/answer-reference";
import {
  loadVerifiedReleaseCached,
  readRegistry,
  resetServerManifestCacheForTests,
} from "@/modules/content/server-release-registry";
import {
  buildComponentKey,
  resolveComponentIdentity,
  type ResolvedComponentIdentity,
} from "@/modules/study-engine";
import {
  createQuestionContextFromRelease,
  generateQuestion,
  type QuestionContext,
  type QuestionInstance,
} from "@/modules/study-engine/generator";

import {
  gradeFlashcardAttempt,
  gradeObjectiveAttempt,
  isSupportedFlashcardRating,
  refsEqual,
  type ObjectiveAttemptFields,
} from "./grade";

const REAL_DIRS = {
  registryDir: "content-server",
  contentServerDir: "content-server",
  publicContentDir: "public/content",
} as const;
const SEED = "grade-test-seed";

let context: QuestionContext;
let identity: ResolvedComponentIdentity;
let instance: QuestionInstance;

beforeAll(async () => {
  const registry = await readRegistry(REAL_DIRS.registryDir);
  const verified = await loadVerifiedReleaseCached(registry.active_release_id, {
    contentServerDir: REAL_DIRS.contentServerDir,
    publicContentDir: REAL_DIRS.publicContentDir,
  });
  context = createQuestionContextFromRelease(verified.learner);

  // Find the first entry that generates a valid meaning_recognition MC question.
  for (const entry of context.entries) {
    try {
      const candidate = resolveComponentIdentity({
        entryId: entry.id,
        skillType: "meaning_recognition",
        sourceField: "madi",
        direction: "arabic_to_english",
      });
      instance = generateQuestion(context, {
        identity: candidate,
        deliveryMode: "mc",
        questionSeed: SEED,
        position: 0,
      });
      identity = candidate;
      break;
    } catch {
      // try the next entry
    }
  }
  if (!instance) throw new Error("no generatable component found in release");
});

afterAll(() => {
  resetServerManifestCacheForTests();
});

function baseAttempt(
  overrides: Partial<ObjectiveAttemptFields> = {},
): ObjectiveAttemptFields {
  return {
    identity,
    mode: "mc",
    questionSeed: SEED,
    questionPosition: 0,
    optionCount: instance.optionCount,
    promptField: instance.promptField,
    questionInstanceId: instance.questionInstanceId,
    questionGeneratorVersion: context.questionGeneratorVersion,
    selectedAnswerRef: instance.correctAnswerRef,
    hintUsed: false,
    claimedIsCorrect: true,
    ...overrides,
  };
}

function aDistractor(): AnswerReference {
  const wrong = instance.allowedAnswerRefs.find(
    (ref) => !refsEqual(ref, instance.correctAnswerRef),
  );
  if (!wrong) throw new Error("no distractor in the reconstructed set");
  return wrong;
}

describe("gradeObjectiveAttempt", () => {
  it("grades a correct answer as correct (Good, no correction)", () => {
    const r = gradeObjectiveAttempt(context, baseAttempt());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isCorrect).toBe(true);
      expect(r.rating).toBe("good");
      expect(r.correctnessCorrected).toBe(false);
    }
  });

  it("corrects a false is_correct claim on a wrong answer (Good -> Again, §10)", () => {
    // Client selected a distractor but claims is_correct=true.
    const r = gradeObjectiveAttempt(
      context,
      baseAttempt({ selectedAnswerRef: aDistractor(), claimedIsCorrect: true }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isCorrect).toBe(false); // server-derived, not the client claim
      expect(r.rating).toBe("again"); // a wrong answer is Again, never Good
      expect(r.correctnessCorrected).toBe(true);
    }
  });

  it("derives Hard for a correct hinted answer and Good for an unhinted one", () => {
    const hinted = gradeObjectiveAttempt(
      context,
      baseAttempt({ hintUsed: true }),
    );
    const unhinted = gradeObjectiveAttempt(
      context,
      baseAttempt({ hintUsed: false }),
    );
    expect(hinted.ok && hinted.rating).toBe("hard");
    expect(unhinted.ok && unhinted.rating).toBe("good");
  });

  it("treats an unanswered attempt as incorrect (Again)", () => {
    const r = gradeObjectiveAttempt(
      context,
      baseAttempt({ selectedAnswerRef: null, claimedIsCorrect: false }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isCorrect).toBe(false);
      expect(r.rating).toBe("again");
    }
  });

  it("rejects a selected option outside the reconstructed set", () => {
    const r = gradeObjectiveAttempt(
      context,
      baseAttempt({ selectedAnswerRef: { entryId: 999999, field: "meaning" } }),
    );
    expect(r).toEqual({ ok: false, reasonCode: "option_not_in_set" });
  });

  it("rejects a mismatched recorded question id (tamper)", () => {
    const r = gradeObjectiveAttempt(
      context,
      baseAttempt({ questionInstanceId: "0".repeat(32) }),
    );
    expect(r).toEqual({ ok: false, reasonCode: "question_mismatch" });
  });

  it("rejects a tampered seed (reconstruction diverges)", () => {
    const r = gradeObjectiveAttempt(
      context,
      baseAttempt({ questionSeed: "a-different-seed" }),
    );
    expect(r).toEqual({ ok: false, reasonCode: "question_mismatch" });
  });

  it("rejects an unsupported generator version recoverably", () => {
    const r = gradeObjectiveAttempt(
      context,
      baseAttempt({ questionGeneratorVersion: "999" }),
    );
    expect(r).toEqual({
      ok: false,
      reasonCode: "unsupported_generator_version",
    });
  });

  it("maps an expected reconstruction failure (bad position) to question_mismatch without logging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = gradeObjectiveAttempt(
      context,
      baseAttempt({ questionPosition: -1 }),
    );
    expect(r).toEqual({ ok: false, reasonCode: "question_mismatch" });
    // A QuestionGenerationError is an expected tamper/invalid-input signal —
    // not an internal defect — so it must NOT be logged as one.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never accepts an ineligible target — the reconstructed key is canonical", () => {
    // Sanity: the graded component's canonical key round-trips.
    expect(buildComponentKey(identity)).toBe(instance.componentKey);
  });
});

describe("gradeFlashcardAttempt", () => {
  it("maps a known self-grade to Good", () => {
    expect(gradeFlashcardAttempt(true).rating).toBe("good");
  });
  it("maps a don't-know self-grade to Again", () => {
    expect(gradeFlashcardAttempt(false).rating).toBe("again");
  });
});

describe("isSupportedFlashcardRating", () => {
  it.each(["again", "good"])("accepts %s", (r) => {
    expect(isSupportedFlashcardRating(r)).toBe(true);
  });
  it.each(["hard", "easy", "bogus"])("rejects %s", (r) => {
    expect(isSupportedFlashcardRating(r)).toBe(false);
  });
});
