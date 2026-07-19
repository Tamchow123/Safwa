/**
 * Hint derivation (Phase 11, §4.4): availability rules, eligibility gating
 * (hard rule 2 — no unverified value ever surfaces, incl. entries 369/372),
 * the no-self-reveal rule, and deterministic values read programmatically
 * from the release (never hand-typed Arabic — hard rule 3).
 */
import { describe, expect, it } from "vitest";

import { normalizeForComparison } from "@/shared/arabic/normalize";

import { fieldValue } from "@/modules/study-engine/fields";
import {
  generateQuestion,
  HINT_TYPES,
  type QuestionInstance,
} from "@/modules/study-engine/generator";
import {
  availableHints,
  hintOfType,
  hintRevealsAnswer,
} from "@/modules/study-engine/hints";
import { splitMasdarAlternatives } from "@/shared/arabic/normalize";

import { entry, learnerEntries, questionContext } from "./fixtures";

function question(
  entryId: number,
  skillType:
    | "meaning_recognition"
    | "meaning_recall"
    | "bab_identification"
    | "root_identification",
  sourceField?: "madi" | "mudari" | "masdar",
): QuestionInstance {
  const isTranslation =
    skillType === "meaning_recognition" || skillType === "meaning_recall";
  return generateQuestion(questionContext, {
    identity: isTranslation
      ? {
          entryId,
          skillType,
          sourceField: sourceField ?? "madi",
          direction:
            skillType === "meaning_recognition"
              ? "arabic_to_english"
              : "english_to_arabic",
        }
      : { entryId, skillType },
    deliveryMode: "mc",
    questionSeed: "hint-test-seed",
    position: 0,
  });
}

describe("availableHints — availability and self-reveal rules", () => {
  it("offers only known hint types, each at most once, in the documented order", () => {
    for (const instance of [
      question(1, "meaning_recognition"),
      question(1, "meaning_recall"),
      question(1, "bab_identification"),
      question(1, "root_identification"),
    ]) {
      const hints = availableHints(questionContext, instance);
      const types = hints.map((hint) => hint.type);
      expect(new Set(types).size).toBe(types.length);
      const order = HINT_TYPES.filter((type) => types.includes(type));
      expect(types).toEqual(order);
      for (const hint of hints) {
        expect(hint.value).not.toBe("");
      }
    }
  });

  it("never offers the hint that IS the answer (root on root, bāb on bāb)", () => {
    const rootQuestion = question(1, "root_identification");
    expect(hintOfType(questionContext, rootQuestion, "root")).toBeNull();
    // Word length of a three-radical root is constant — no information.
    expect(hintOfType(questionContext, rootQuestion, "word_length")).toBeNull();

    const babQuestion = question(1, "bab_identification");
    expect(hintOfType(questionContext, babQuestion, "bab")).toBeNull();
    // Pattern pairs are not word-shaped: no first letter / word length.
    expect(hintOfType(questionContext, babQuestion, "first_letter")).toBeNull();
    expect(hintOfType(questionContext, babQuestion, "word_length")).toBeNull();
    // Prompt form + "another form" would spell out the bāb pair — suppressed.
    expect(hintOfType(questionContext, babQuestion, "form")).toBeNull();
  });

  it("never offers a near-total reveal: no root hint on a māḍī answer", () => {
    // En→Ar recall of the māḍī: the māḍī is the bare root plus vowels, so a
    // root hint would hand over the full consonant skeleton.
    const madiRecall = question(1, "meaning_recall", "madi");
    expect(hintOfType(questionContext, madiRecall, "root")).toBeNull();
    // A non-māḍī recall target still gets the root hint (a real, partial cue).
    const masdarRecall = question(1, "meaning_recall", "masdar");
    expect(hintOfType(questionContext, masdarRecall, "root")).not.toBeNull();
  });

  it("the 'another form' hint never shows the prompt or the answer field", () => {
    for (const instance of [
      question(1, "meaning_recognition"),
      question(1, "meaning_recall"),
      question(1, "bab_identification"),
    ]) {
      const formHint = hintOfType(questionContext, instance, "form");
      if (formHint === null) continue;
      const promptValue = fieldValue(
        entry(instance.entryId),
        instance.promptField,
      );
      const answerValue = fieldValue(
        entry(instance.entryId),
        instance.answerField,
      );
      expect(normalizeForComparison(formHint.value)).not.toBe(
        normalizeForComparison(promptValue),
      );
      expect(normalizeForComparison(formHint.value)).not.toBe(
        normalizeForComparison(answerValue),
      );
    }
  });

  it("never exposes an unverified root: entries 369/372 get no root hint anywhere", () => {
    for (const id of [369, 372]) {
      const unresolved = entry(id);
      expect(unresolved.quiz_eligibility.root).toBe(false);
      const instance = question(id, "meaning_recognition");
      expect(hintOfType(questionContext, instance, "root")).toBeNull();
      // Every hint that IS offered only carries eligible values.
      for (const hint of availableHints(questionContext, instance)) {
        expect(hint.type).not.toBe("root");
      }
    }
  });

  it("offers root and bāb hints (eligible entry, translation question)", () => {
    const instance = question(1, "meaning_recognition");
    const rootHint = hintOfType(questionContext, instance, "root");
    const babHint = hintOfType(questionContext, instance, "bab");
    expect(rootHint).not.toBeNull();
    expect(rootHint!.isArabic).toBe(true);
    expect(rootHint!.value).toBe(fieldValue(entry(1), "root"));
    expect(babHint).not.toBeNull();
    expect(babHint!.value).toBe(fieldValue(entry(1), "bab"));
  });

  it("derives first letter and word length from the correct answer value", () => {
    // En→Ar recall of the māḍī: the answer is the Arabic māḍī form.
    const recall = question(1, "meaning_recall", "madi");
    const madi = fieldValue(entry(1), "madi");
    const firstLetter = hintOfType(questionContext, recall, "first_letter");
    expect(firstLetter).not.toBeNull();
    expect(firstLetter!.isArabic).toBe(true);
    // The hint is the first BASE letter of the value (a real prefix character).
    expect([...madi][0]).toBe(firstLetter!.value);

    const wordLength = hintOfType(questionContext, recall, "word_length");
    expect(wordLength).not.toBeNull();
    expect(wordLength!.isArabic).toBe(false);
    expect(wordLength!.value).toMatch(/^\d+ letters$/);
    // Letter count excludes combining marks: never more than code points.
    const count = Number.parseInt(wordLength!.value, 10);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual([...madi].length);
  });

  it("word length counts LETTERS only — punctuation and digits never count", () => {
    // A real entry whose first gloss contains non-letter characters
    // (parentheses/apostrophes/hyphens), found programmatically.
    const punctuated = learnerEntries.find((candidate) => {
      if (
        !candidate.quiz_eligibility.meaning ||
        !candidate.quiz_eligibility.madi
      ) {
        return false;
      }
      const gloss = candidate.meaning
        .split(/[,;]/, 1)[0]
        .trim()
        .replace(/^to\s+/i, "");
      return /[^\p{L}\s]/u.test(gloss) && /\p{L}/u.test(gloss);
    });
    expect(punctuated).toBeDefined();
    const instance = question(punctuated!.id, "meaning_recognition", "madi");
    const wordLength = hintOfType(questionContext, instance, "word_length");
    expect(wordLength).not.toBeNull();
    const gloss = punctuated!.meaning
      .split(/[,;]/, 1)[0]
      .trim()
      .replace(/^to\s+/i, "");
    const letterOnly = [...gloss].filter((char) => /\p{L}/u.test(char)).length;
    const counted = Number.parseInt(wordLength!.value, 10);
    expect(counted).toBe(letterOnly);
    // Strictly fewer than the raw non-space count (the punctuation is there).
    const withPunctuation = [...gloss].filter((c) => c.trim() !== "").length;
    expect(counted).toBeLessThan(withPunctuation);
  });

  it("strips a leading 'to ' from English base-meaning hints", () => {
    const withTo = learnerEntries.find(
      (candidate) =>
        candidate.quiz_eligibility.meaning &&
        candidate.quiz_eligibility.madi &&
        /^to\s+\S/i.test(candidate.meaning),
    );
    expect(withTo).toBeDefined();
    const instance = question(withTo!.id, "meaning_recognition", "madi");
    const firstLetter = hintOfType(questionContext, instance, "first_letter");
    expect(firstLetter).not.toBeNull();
    const gloss = withTo!.meaning.split(/[,;]/, 1)[0].trim();
    const target = gloss.replace(/^to\s+/i, "");
    expect(firstLetter!.value).toBe([...target][0]);
    expect(firstLetter!.isArabic).toBe(false);
  });

  it("a maṣdar answer is revealed by ANY single alternative (field-aware policy)", () => {
    // A real multi-alternative maṣdar cell, found programmatically: every
    // alternative is an accepted answer (hard rule 4 set semantics), so a
    // hint equal to any ONE of them reveals the answer even though it never
    // equals the whole cell.
    const multi = learnerEntries.find(
      (candidate) =>
        candidate.quiz_eligibility.masdar &&
        splitMasdarAlternatives(candidate.masdar).length > 1,
    );
    expect(multi).toBeDefined();
    const alternatives = splitMasdarAlternatives(multi!.masdar);
    for (const alternative of alternatives) {
      expect(hintRevealsAnswer("masdar", multi!.masdar, alternative)).toBe(
        true,
      );
    }
    // The full cell is never a candidate surface in practice, and an
    // unrelated value never matches.
    expect(hintRevealsAnswer("masdar", multi!.masdar, multi!.madi)).toBe(
      splitMasdarAlternatives(multi!.masdar).some(
        (alternative) => alternative === multi!.madi,
      ),
    );
    // Non-maṣdar fields stay whole-value equality.
    expect(hintRevealsAnswer("madi", multi!.madi, multi!.madi)).toBe(true);
    expect(hintRevealsAnswer("madi", multi!.madi, alternatives[0])).toBe(
      multi!.madi === alternatives[0],
    );
  });

  it("is deterministic: identical inputs produce identical hints", () => {
    const instance = question(7, "meaning_recognition");
    expect(availableHints(questionContext, instance)).toEqual(
      availableHints(questionContext, instance),
    );
  });

  it("throws for an entry missing from the loaded release", () => {
    const instance = question(1, "meaning_recognition");
    const foreign = { ...instance, entryId: 99999 };
    expect(() => availableHints(questionContext, foreign)).toThrow(
      /not in the loaded content release/,
    );
  });
});
