import { describe, expect, it } from "vitest";

import { EXPECTED_DUPLICATE_MADI_GROUPS } from "@/modules/content/constants";
import { deriveComponentsForEntry } from "@/modules/study-engine/components";
import { fieldValue } from "@/modules/study-engine/fields";
import {
  assertValidHintState,
  createQuestionContext,
  DEFAULT_OPTION_COUNT,
  ENGINE_QUESTION_GENERATOR_VERSION,
  generateFromSpec,
  generateQuestion,
  NO_HINT,
  QuestionGenerationError,
  specForQuestion,
  UnsupportedGeneratorVersionError,
  type GenerateQuestionRequest,
  type HintState,
} from "@/modules/study-engine/generator";
import { normalizeForComparison } from "@/shared/arabic/normalize";

import {
  entry,
  learnerEntries,
  learnerRelease,
  questionContext,
} from "./fixtures";

const ARABIC = /[؀-ۿ]/;

function mcRequest(
  overrides: Partial<GenerateQuestionRequest> & {
    identity: GenerateQuestionRequest["identity"];
  },
): GenerateQuestionRequest {
  return {
    deliveryMode: "mc",
    questionSeed: "seed-1",
    position: 0,
    ...overrides,
  };
}

describe("hint state validation", () => {
  it("accepts the two consistent states and rejects contradictions", () => {
    expect(assertValidHintState(NO_HINT)).toEqual(NO_HINT);
    expect(assertValidHintState({ used: true, type: "root" })).toEqual({
      used: true,
      type: "root",
    });
    // used with no type
    expect(() =>
      assertValidHintState({ used: true, type: null } as unknown as HintState),
    ).toThrow(QuestionGenerationError);
    // type with used=false
    expect(() =>
      assertValidHintState({
        used: false,
        type: "root",
      } as unknown as HintState),
    ).toThrow(QuestionGenerationError);
    // used with an UNKNOWN type (deserialized data)
    expect(() =>
      assertValidHintState({
        used: true,
        type: "invented",
      } as unknown as HintState),
    ).toThrow(QuestionGenerationError);
    // non-boolean used
    expect(() =>
      assertValidHintState({
        used: "yes",
        type: null,
      } as unknown as HintState),
    ).toThrow(QuestionGenerationError);
  });
});

describe("hint state — no shared mutable module state", () => {
  const request = {
    identity: {
      entryId: 1,
      skillType: "meaning_recognition" as const,
      sourceField: "madi" as const,
      direction: "arabic_to_english" as const,
    },
    deliveryMode: "mc" as const,
    questionSeed: "hint-share",
    position: 0,
  };

  it("gives each generated question an independent hint-state object", () => {
    const q1 = generateQuestion(questionContext, request);
    // Mutate q1's hint state in place (as a caller recording a hint might).
    (q1.hintState as { used: boolean; type: string | null }).used = true;
    // A later identical generation must be unaffected.
    const q2 = generateQuestion(questionContext, request);
    expect(q2.hintState).toEqual({ used: false, type: null });
    expect(q1.hintState).not.toBe(q2.hintState);
  });

  it("freezes the NO_HINT singleton so it can't become shared mutable state", () => {
    expect(Object.isFrozen(NO_HINT)).toBe(true);
  });
});

describe("question context — generator version guard", () => {
  it("accepts a release built by this engine's generator version", () => {
    expect(learnerRelease.question_generator_version).toBe(
      ENGINE_QUESTION_GENERATOR_VERSION,
    );
    expect(() => createQuestionContext(learnerRelease)).not.toThrow();
  });

  it("rejects a release built by an unimplemented generator version", () => {
    expect(() =>
      createQuestionContext({
        ...learnerRelease,
        question_generator_version: "999",
      }),
    ).toThrow(UnsupportedGeneratorVersionError);
  });

  it("keys identity on the authoritative release_id, not content_version", () => {
    // Two releases that share content_version but differ in release_id (a
    // corrected release) must produce DISTINCT instance ids and reject each
    // other's specs — content_version is not an identifier (ADR-003).
    const ctxA = createQuestionContext(learnerRelease);
    const ctxB = createQuestionContext({
      ...learnerRelease,
      release_id: `${learnerRelease.release_id}-corrected`, // same content_version
    });
    expect(ctxA.contentVersion).toBe(ctxB.contentVersion);

    const req = {
      identity: { entryId: 1, skillType: "bab_identification" as const },
      deliveryMode: "mc" as const,
      questionSeed: "rel",
      position: 0,
    };
    const a = generateQuestion(ctxA, req);
    const b = generateQuestion(ctxB, req);
    expect(a.questionInstanceId).not.toBe(b.questionInstanceId);
    expect(a.releaseId).toBe(learnerRelease.release_id);

    // A spec from release A cannot be replayed against release B.
    expect(() => generateFromSpec(ctxB, specForQuestion(a))).toThrow(
      QuestionGenerationError,
    );
    // And the attempt/instance carry release_id.
    expect(specForQuestion(a).releaseId).toBe(learnerRelease.release_id);
  });
});

describe("question generation — determinism", () => {
  const request = mcRequest({
    identity: {
      entryId: 1,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    },
  });

  it("same inputs reproduce the identical question", () => {
    const a = generateQuestion(questionContext, request);
    const b = generateQuestion(questionContext, request);
    expect(a).toEqual(b);
  });

  it("a recorded spec regenerates the identical question (incl. JSON round-trip)", () => {
    const original = generateQuestion(questionContext, request);
    const spec = specForQuestion(original);
    expect(generateFromSpec(questionContext, spec)).toEqual(original);
    // The spec must survive JSON serialisation (it is persisted on the attempt).
    const roundTripped = JSON.parse(JSON.stringify(spec));
    expect(generateFromSpec(questionContext, roundTripped)).toEqual(original);
    // The spec carries the full question-instance specification fields.
    expect(spec.questionInstanceId).toBe(original.questionInstanceId);
    expect(spec.allowedAnswerRefs).toEqual(original.allowedAnswerRefs);
    expect(spec.correctAnswerRef).toEqual(original.correctAnswerRef);
    expect(spec.hintState).toEqual(original.hintState);
  });

  it("distinct position / mode / prompt form yield distinct questions and ids", () => {
    const base = generateQuestion(questionContext, request);
    const otherPos = generateQuestion(
      questionContext,
      mcRequest({ identity: request.identity, position: 1 }),
    );
    const asFlashcard = generateQuestion(
      questionContext,
      mcRequest({ identity: request.identity, deliveryMode: "flashcard" }),
    );
    const otherSeed = generateQuestion(
      questionContext,
      mcRequest({ identity: request.identity, questionSeed: "seed-2" }),
    );
    const ids = new Set([
      base.questionInstanceId,
      otherPos.questionInstanceId,
      asFlashcard.questionInstanceId,
      otherSeed.questionInstanceId,
    ]);
    expect(ids.size).toBe(4); // all structurally distinct
  });

  it("distinct delivery modes yield distinct instance ids and specs", () => {
    // Same seed/component/position/prompt across mc, timed and test — the same
    // question STRUCTURE, but distinct instances (delivery mode is folded in).
    const forMode = (deliveryMode: "mc" | "timed" | "test") =>
      generateQuestion(
        questionContext,
        mcRequest({ identity: request.identity, deliveryMode }),
      );
    const mc = forMode("mc");
    const timed = forMode("timed");
    const test = forMode("test");
    const ids = new Set([
      mc.questionInstanceId,
      timed.questionInstanceId,
      test.questionInstanceId,
    ]);
    expect(ids.size).toBe(3);
    expect(specForQuestion(timed).deliveryMode).toBe("timed");
    // Structure is still "mc" for all three.
    expect([mc.mode, timed.mode, test.mode]).toEqual(["mc", "mc", "mc"]);
    // Each round-trips through its own spec.
    expect(generateFromSpec(questionContext, specForQuestion(timed))).toEqual(
      timed,
    );
  });

  it("rejects malformed direct-generation requests at the public boundary", () => {
    // Types don't protect JS/deserialized callers; generateQuestion must reject
    // inputs that generateFromSpec would later refuse, so specs always replay.
    expect(() =>
      generateQuestion(questionContext, {
        ...request,
        // @ts-expect-error — numeric seed rejected at runtime
        questionSeed: 1,
      }),
    ).toThrow(QuestionGenerationError);
    expect(() =>
      generateQuestion(questionContext, {
        ...request,
        // @ts-expect-error — unknown delivery mode rejected at runtime
        deliveryMode: "exam",
      }),
    ).toThrow(QuestionGenerationError);
  });

  it("rejects a position that would not survive JSON replay", () => {
    for (const badPosition of [Number.NaN, Infinity, -1, 1.5, -0]) {
      expect(() =>
        generateQuestion(
          questionContext,
          mcRequest({ identity: request.identity, position: badPosition }),
        ),
      ).toThrow(QuestionGenerationError);
    }
  });

  it("rejects a spec carrying an unknown delivery mode or invalid hint state", () => {
    const spec = specForQuestion(generateQuestion(questionContext, request));
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        // @ts-expect-error — unknown delivery mode rejected at runtime
        deliveryMode: "exam",
      }),
    ).toThrow(QuestionGenerationError);
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        // @ts-expect-error — unknown hint type rejected at runtime
        hintState: { used: true, type: "invented" },
      }),
    ).toThrow(QuestionGenerationError);
    // A mistyped questionSeed (number instead of string) is rejected — it must
    // not silently pass tamper detection via string/number encoding collapse.
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        // @ts-expect-error — numeric seed rejected at runtime
        questionSeed: 1,
      }),
    ).toThrow(QuestionGenerationError);
  });

  it("distinct entry-level prompt forms yield distinct ids and round-trip", () => {
    // Prompt form is the entry-level disambiguator folded into the instance
    // seed; two bāb questions differing ONLY in prompt form must be distinct.
    const withMadi = generateQuestion(
      questionContext,
      mcRequest({
        identity: { entryId: 1, skillType: "bab_identification" },
        promptForm: "madi",
      }),
    );
    const withMudari = generateQuestion(
      questionContext,
      mcRequest({
        identity: { entryId: 1, skillType: "bab_identification" },
        promptForm: "mudari",
      }),
    );
    expect(withMudari.questionInstanceId).not.toBe(withMadi.questionInstanceId);
    expect(withMudari.promptField).toBe("mudari");
    // Each round-trips through its own spec.
    expect(
      generateFromSpec(questionContext, specForQuestion(withMadi)),
    ).toEqual(withMadi);
    expect(
      generateFromSpec(questionContext, specForQuestion(withMudari)),
    ).toEqual(withMudari);
  });

  it("detects tampering with the recorded spec's derived fields", () => {
    const spec = specForQuestion(generateQuestion(questionContext, request));
    // Altered correct answer ref.
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        correctAnswerRef: { entryId: 999, field: "meaning" },
      }),
    ).toThrow(QuestionGenerationError);
    // Altered instance id.
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        questionInstanceId: "deadbeef",
      }),
    ).toThrow(QuestionGenerationError);
    // Altered allowed answer refs.
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        allowedAnswerRefs: [{ entryId: 1, field: "meaning" }],
      }),
    ).toThrow(QuestionGenerationError);
    // Altered prompt field on a translation spec (madi → mudari): the prompt
    // field is fixed by the skill/direction, so the tamper must be rejected,
    // not silently normalised back to madi.
    expect(spec.promptField).toBe("madi");
    expect(() =>
      generateFromSpec(questionContext, { ...spec, promptField: "mudari" }),
    ).toThrow(QuestionGenerationError);
  });

  it("assigns collision-free 128-bit instance ids across many seeds", () => {
    const ids = new Set<string>();
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const q = generateQuestion(
        questionContext,
        mcRequest({ identity: request.identity, questionSeed: `seed-${i}` }),
      );
      expect(q.questionInstanceId).toMatch(/^[0-9a-f]{32}$/); // 128-bit
      ids.add(q.questionInstanceId);
    }
    // No 32-bit-style collisions at this scale.
    expect(ids.size).toBe(N);
  });

  it("rejects a spec whose version disagrees with the context", () => {
    const spec = specForQuestion(generateQuestion(questionContext, request));
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        questionGeneratorVersion: "999",
      }),
    ).toThrow(QuestionGenerationError);
    expect(() =>
      generateFromSpec(questionContext, {
        ...spec,
        contentVersion: "0.0.0",
      }),
    ).toThrow(QuestionGenerationError);
  });
});

describe("question generation — option invariants (all entries × skills)", () => {
  // Heavy: generates an MC question for every eligible component of all 455
  // entries. A generous timeout keeps it reliable under full parallel CPU load
  // (it runs in ~3.5s isolated) without weakening any assertion.
  it("every MC question has 4 unique options with the answer present once, all eligible", () => {
    for (const e of learnerEntries) {
      for (const component of deriveComponentsForEntry(e)) {
        const question = generateQuestion(
          questionContext,
          mcRequest({
            identity: {
              entryId: component.entryId,
              skillType: component.skillType,
              sourceField: component.sourceField,
              direction: component.direction,
            },
          }),
        );

        // Exactly four options.
        expect(question.options, question.componentKey).toHaveLength(
          DEFAULT_OPTION_COUNT,
        );
        // Unique after normalisation.
        const normalized = question.options.map((o) =>
          normalizeForComparison(o.displayValue),
        );
        expect(new Set(normalized).size, question.componentKey).toBe(
          normalized.length,
        );
        // Exactly one correct option, matching the correct answer ref.
        const correct = question.options.filter((o) => o.isCorrect);
        expect(correct, question.componentKey).toHaveLength(1);
        expect(correct[0].ref).toEqual(question.correctAnswerRef);

        // The prompt field is eligible for the entry.
        expect(
          e.quiz_eligibility[
            question.promptField as keyof typeof e.quiz_eligibility
          ],
          `${question.componentKey} prompt ${question.promptField}`,
        ).toBe(true);

        // Every option references an entry whose ANSWER field is eligible —
        // ineligible values can never appear as a distractor.
        for (const option of question.options) {
          expect(option.ref.field).toBe(question.answerField);
          const referenced = entry(option.ref.entryId);
          expect(
            referenced.quiz_eligibility[
              option.ref.field as keyof typeof referenced.quiz_eligibility
            ],
            `${question.componentKey} option entry ${option.ref.entryId}`,
          ).toBe(true);
        }
      }
    }
  }, 60000);
});

describe("question generation — bāb options are Arabic pairs", () => {
  it("renders bab_arabic values, never numbering or transliteration alone", () => {
    const question = generateQuestion(
      questionContext,
      mcRequest({ identity: { entryId: 1, skillType: "bab_identification" } }),
    );
    expect(question.answerField).toBe("bab");
    const babArabicValues = new Set(learnerEntries.map((e) => e.bab_arabic));
    for (const option of question.options) {
      expect(option.displayValue).toMatch(ARABIC); // contains Arabic script
      expect(option.displayValue).not.toMatch(/\b(Form|I{1,3}|IV|V|VI)\b/);
      expect(babArabicValues.has(option.displayValue)).toBe(true);
    }
    // Correct option is entry 1's bāb pair.
    const correct = question.options.find((o) => o.isCorrect)!;
    expect(correct.displayValue).toBe(entry(1).bab_arabic);
  });

  it("respects a configured prompt form for entry-level questions", () => {
    const question = generateQuestion(
      questionContext,
      mcRequest({
        identity: { entryId: 1, skillType: "bab_identification" },
        promptForm: "mudari",
      }),
    );
    expect(question.promptField).toBe("mudari");
    expect(question.promptRef).toEqual({ entryId: 1, field: "mudari" });
  });
});

describe("question generation — duplicate-māḍī ambiguity exclusion", () => {
  it("duplicate-madi partners never distract each other where the surface is ambiguous", () => {
    for (const [a, b] of EXPECTED_DUPLICATE_MADI_GROUPS) {
      const entryA = entry(a);
      const entryB = entry(b);

      // En→Ar recall on madi: the answer is the (shared) madi surface form,
      // so it appears exactly ONCE (as the correct option) and partner B never
      // appears as a distractor — its identical surface can't be a second
      // option.
      const recall = generateQuestion(
        questionContext,
        mcRequest({
          identity: {
            entryId: a,
            skillType: "meaning_recall",
            sourceField: "madi",
            direction: "english_to_arabic",
          },
        }),
      );
      expect(recall.options.every((o) => o.ref.entryId !== b)).toBe(true);
      const sharedSurface = normalizeForComparison(entryB.madi);
      const sharedCount = recall.options.filter(
        (o) => normalizeForComparison(o.displayValue) === sharedSurface,
      ).length;
      expect(sharedCount).toBe(1);
      const correctRecall = recall.options.find((o) => o.isCorrect)!;
      expect(normalizeForComparison(correctRecall.displayValue)).toBe(
        sharedSurface,
      );

      // Ar→En recognition prompted with the shared madi: partner B is
      // ambiguous for the same prompt and never appears as a distractor.
      // (The two share the madi surface by design.)
      expect(normalizeForComparison(entryA.madi)).toBe(
        normalizeForComparison(entryB.madi),
      );
      const recognition = generateQuestion(
        questionContext,
        mcRequest({
          identity: {
            entryId: a,
            skillType: "meaning_recognition",
            sourceField: "madi",
            direction: "arabic_to_english",
          },
        }),
      );
      expect(recognition.options.every((o) => o.ref.entryId !== b)).toBe(true);
      // If B's meaning differs from A's it must be absent; if it coincides it
      // may appear only as the single correct option.
      const bMeaning = normalizeForComparison(fieldValue(entryB, "meaning"));
      const aMeaning = normalizeForComparison(fieldValue(entryA, "meaning"));
      const bMeaningOptions = recognition.options.filter(
        (o) => normalizeForComparison(o.displayValue) === bMeaning,
      );
      if (bMeaning === aMeaning) {
        expect(bMeaningOptions).toHaveLength(1);
        expect(bMeaningOptions[0].isCorrect).toBe(true);
      } else {
        expect(bMeaningOptions).toHaveLength(0);
      }
    }
  });
});

describe("question generation — maṣdar alternative safety", () => {
  // Comparison is split-aware (hard rule 4): maṣdar values compare as their
  // order-independent " / " alternative set, so no option set can contain two
  // maṣdar cells with the same alternatives (reordered or overlapping). The
  // DISPLAYED cell remains the canonical whole cell (matching the assessment
  // manifest). This guard asserts the resulting invariant on every eligible
  // maṣdar recall question.
  const altSig = (cell: string) =>
    cell
      .split(" / ")
      .map((alt) => normalizeForComparison(alt))
      .sort()
      .join("|||");

  it("no En→Ar masdar option set contains two equal alternative-sets", () => {
    for (const e of learnerEntries) {
      if (!e.quiz_eligibility.masdar || !e.quiz_eligibility.meaning) continue;
      const question = generateQuestion(
        questionContext,
        mcRequest({
          identity: {
            entryId: e.id,
            skillType: "meaning_recall",
            sourceField: "masdar",
            direction: "english_to_arabic",
          },
        }),
      );
      const sigs = question.options.map((o) => altSig(o.displayValue));
      expect(new Set(sigs).size, `entry ${e.id}`).toBe(sigs.length);
    }
  }, 60000);
});

describe("question generation — flashcards and eligibility guards", () => {
  it("generates a flashcard prompt for a translation component", () => {
    const recognition = generateQuestion(
      questionContext,
      mcRequest({
        deliveryMode: "flashcard",
        identity: {
          entryId: 1,
          skillType: "meaning_recognition",
          sourceField: "madi",
          direction: "arabic_to_english",
        },
      }),
    );
    expect(recognition.mode).toBe("flashcard");
    expect(recognition.options).toHaveLength(0);
    expect(recognition.promptField).toBe("madi");
    expect(recognition.answerField).toBe("meaning");
    expect(recognition.allowedAnswerRefs).toEqual([
      recognition.correctAnswerRef,
    ]);
  });

  it("refuses a flashcard for an entry-level component", () => {
    expect(() =>
      generateQuestion(
        questionContext,
        mcRequest({
          deliveryMode: "flashcard",
          identity: { entryId: 1, skillType: "bab_identification" },
        }),
      ),
    ).toThrow(QuestionGenerationError);
  });

  it("ineligible verb-type metadata cannot influence generated questions", () => {
    // Entry 369's verb_type is ineligible. Its stored classification must not
    // affect plausibility ranking, so changing it leaves questions identical.
    const clone = (verbTypeFor369: string) => {
      const release = JSON.parse(JSON.stringify(learnerRelease));
      const e369 = release.entries.find((e: { id: number }) => e.id === 369);
      expect(e369.quiz_eligibility.verb_type).toBe(false);
      e369.verb_type = verbTypeFor369;
      return createQuestionContext(release);
    };
    // Generate a meaning question on entry 1 (369 is a meaning candidate) under
    // two different (ineligible) verb_type values for 369.
    const req = mcRequest({
      identity: {
        entryId: 1,
        skillType: "meaning_recognition",
        sourceField: "madi",
        direction: "arabic_to_english",
      },
    });
    const a = generateQuestion(clone("sahih"), req);
    const b = generateQuestion(clone("mudaaf"), req);
    expect(b.options).toEqual(a.options);
  });

  it("refuses to generate an ineligible component (369 root)", () => {
    expect(() =>
      generateQuestion(
        questionContext,
        mcRequest({
          identity: { entryId: 369, skillType: "root_identification" },
        }),
      ),
    ).toThrow(QuestionGenerationError);
  });

  it("refuses an ineligible entry-level prompt form and accepts an eligible one", () => {
    // Find a real entry with an ineligible source form (some entries lack an
    // eligible mudari/masdar/etc.) and prove a bāb question refuses to prompt
    // with it, while an eligible prompt form succeeds.
    const PROMPTABLE = ["mudari", "masdar", "ism_fail", "amr", "nahi"] as const;
    let checked = 0;
    for (const e of learnerEntries) {
      if (!e.quiz_eligibility.bab) continue;
      for (const form of PROMPTABLE) {
        if (e.quiz_eligibility[form]) continue; // only ineligible forms here
        expect(
          () =>
            generateQuestion(
              questionContext,
              mcRequest({
                identity: { entryId: e.id, skillType: "bab_identification" },
                promptForm: form,
              }),
            ),
          `entry ${e.id} ineligible prompt ${form}`,
        ).toThrow(QuestionGenerationError);
        checked++;
      }
    }
    // The dataset has ineligible mudari/masdar/etc., so we must have exercised
    // the rejection path (guards against a vacuous test).
    expect(checked).toBeGreaterThan(0);

    // Control: an eligible prompt form (madi, eligible for all 455) succeeds.
    expect(() =>
      generateQuestion(
        questionContext,
        mcRequest({
          identity: { entryId: 1, skillType: "bab_identification" },
          promptForm: "madi",
        }),
      ),
    ).not.toThrow();
  });
});

describe("question generation — eligibility accept/reject (all entries × skills)", () => {
  const FORM_SKILLS = [
    { skill: "meaning_recognition", direction: "arabic_to_english" },
    { skill: "meaning_recall", direction: "english_to_arabic" },
  ] as const;
  const FORM_FIELDS = [
    "madi",
    "mudari",
    "masdar",
    "ism_fail",
    "amr",
    "nahi",
  ] as const;

  it("generates iff the dependent fields are eligible, and rejects otherwise", () => {
    for (const e of learnerEntries) {
      // Translation components: eligible iff the form AND meaning are eligible.
      for (const { skill, direction } of FORM_SKILLS) {
        for (const field of FORM_FIELDS) {
          const eligible =
            e.quiz_eligibility[field] && e.quiz_eligibility.meaning;
          const req = mcRequest({
            identity: {
              entryId: e.id,
              skillType: skill,
              sourceField: field,
              direction,
            },
          });
          if (eligible) {
            expect(() => generateQuestion(questionContext, req)).not.toThrow();
          } else {
            expect(
              () => generateQuestion(questionContext, req),
              `${e.id} ${skill}:${field}`,
            ).toThrow(QuestionGenerationError);
          }
        }
      }

      // Entry-level components: eligible strictly by their own boolean.
      const entryLevel = [
        ["bab_identification", e.quiz_eligibility.bab],
        ["root_identification", e.quiz_eligibility.root],
        ["verb_type_identification", e.quiz_eligibility.verb_type],
      ] as const;
      for (const [skill, eligible] of entryLevel) {
        const req = mcRequest({
          identity: { entryId: e.id, skillType: skill },
        });
        if (eligible) {
          expect(() => generateQuestion(questionContext, req)).not.toThrow();
        } else {
          expect(
            () => generateQuestion(questionContext, req),
            `${e.id} ${skill}`,
          ).toThrow(QuestionGenerationError);
        }
      }
    }
  }, 60000);
});
