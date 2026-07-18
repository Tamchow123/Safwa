import { describe, expect, it } from "vitest";

import {
  SKILL_METADATA,
  SOURCE_QUIZ_FORM_FIELDS,
} from "@/modules/content/constants";
import {
  buildComponentKey,
  InvalidComponentIdentityError,
  isValidComponentKey,
  parseComponentKey,
  resolveComponentIdentity,
} from "@/modules/study-engine/natural-key";

describe("natural-key builder", () => {
  it("builds the documented form-component key", () => {
    expect(
      buildComponentKey({
        entryId: 42,
        skillType: "meaning_recognition",
        sourceField: "masdar",
        direction: "arabic_to_english",
      }),
    ).toBe(
      "entry:42:skill:meaning_recognition:field:masdar:direction:arabic_to_english",
    );
  });

  it("builds the documented entry-level key", () => {
    expect(
      buildComponentKey({ entryId: 7, skillType: "bab_identification" }),
    ).toBe("entry:7:skill:bab_identification");
  });

  it("round-trips every valid form component", () => {
    for (const field of SOURCE_QUIZ_FORM_FIELDS) {
      for (const skill of ["meaning_recognition", "meaning_recall"] as const) {
        const direction =
          skill === "meaning_recognition"
            ? "arabic_to_english"
            : "english_to_arabic";
        const key = buildComponentKey({
          entryId: 3,
          skillType: skill,
          sourceField: field,
          direction,
        });
        expect(isValidComponentKey(key)).toBe(true);
        expect(parseComponentKey(key)).toEqual({
          entryId: 3,
          skillType: skill,
          componentShape: "form_direction",
          sourceField: field,
          direction,
        });
      }
    }
  });

  it("round-trips every entry-level skill", () => {
    for (const skill of SKILL_METADATA.filter(
      (m) => m.component_shape === "entry_level",
    )) {
      const key = buildComponentKey({ entryId: 5, skillType: skill.id });
      expect(parseComponentKey(key)).toEqual({
        entryId: 5,
        skillType: skill.id,
        componentShape: "entry_level",
        sourceField: null,
        direction: null,
      });
    }
  });

  it("rejects a form skill missing its field or direction", () => {
    expect(() =>
      buildComponentKey({ entryId: 1, skillType: "meaning_recognition" }),
    ).toThrow(InvalidComponentIdentityError);
    expect(() =>
      buildComponentKey({
        entryId: 1,
        skillType: "meaning_recognition",
        sourceField: "madi",
      }),
    ).toThrow(InvalidComponentIdentityError);
  });

  it("rejects a direction not allowed for the skill", () => {
    // meaning_recognition is Ar→En only.
    expect(() =>
      buildComponentKey({
        entryId: 1,
        skillType: "meaning_recognition",
        sourceField: "madi",
        direction: "english_to_arabic",
      }),
    ).toThrow(InvalidComponentIdentityError);
    // meaning_recall is En→Ar only.
    expect(() =>
      buildComponentKey({
        entryId: 1,
        skillType: "meaning_recall",
        sourceField: "madi",
        direction: "arabic_to_english",
      }),
    ).toThrow(InvalidComponentIdentityError);
  });

  it("rejects an entry-level skill carrying a field or direction", () => {
    expect(() =>
      resolveComponentIdentity({
        entryId: 1,
        skillType: "bab_identification",
        sourceField: "madi",
      }),
    ).toThrow(InvalidComponentIdentityError);
    expect(() =>
      resolveComponentIdentity({
        entryId: 1,
        skillType: "root_identification",
        direction: "arabic_to_english",
      }),
    ).toThrow(InvalidComponentIdentityError);
  });

  it("rejects a supplied component-shape that mismatches the skill", () => {
    // entry-level skill claimed as form_direction
    expect(() =>
      resolveComponentIdentity({
        entryId: 1,
        skillType: "bab_identification",
        componentShape: "form_direction",
      }),
    ).toThrow(InvalidComponentIdentityError);
    // form skill claimed as entry_level
    expect(() =>
      resolveComponentIdentity({
        entryId: 1,
        skillType: "meaning_recognition",
        sourceField: "madi",
        direction: "arabic_to_english",
        componentShape: "entry_level",
      }),
    ).toThrow(InvalidComponentIdentityError);
  });

  it("accepts a supplied component-shape that matches the skill", () => {
    expect(
      buildComponentKey({
        entryId: 1,
        skillType: "bab_identification",
        componentShape: "entry_level",
      }),
    ).toBe("entry:1:skill:bab_identification");
    expect(
      resolveComponentIdentity({
        entryId: 1,
        skillType: "meaning_recall",
        sourceField: "madi",
        direction: "english_to_arabic",
        componentShape: "form_direction",
      }).componentShape,
    ).toBe("form_direction");
  });

  it("rejects unknown skills and non-positive ids", () => {
    expect(() =>
      // @ts-expect-error — unknown skill rejected at runtime too
      buildComponentKey({ entryId: 1, skillType: "typed_meaning_recall" }),
    ).toThrow(InvalidComponentIdentityError);
    expect(() =>
      buildComponentKey({ entryId: 0, skillType: "bab_identification" }),
    ).toThrow(InvalidComponentIdentityError);
    expect(() =>
      buildComponentKey({ entryId: 1.5, skillType: "bab_identification" }),
    ).toThrow(InvalidComponentIdentityError);
    // An unsafe integer (e.g. 1e21) stringifies to scientific notation and
    // could not be parsed back — the builder must reject it, not emit an
    // un-round-trippable key.
    expect(() =>
      buildComponentKey({ entryId: 1e21, skillType: "bab_identification" }),
    ).toThrow(InvalidComponentIdentityError);
  });

  it("rejects malformed and shape-inconsistent key strings", () => {
    for (const bad of [
      "",
      "entry:1",
      "entry:1:skill:bab_identification:field:madi:direction:arabic_to_english", // entry-level can't carry field
      "entry:0:skill:bab_identification",
      "entry:1:skill:meaning_recognition:field:madi:direction:english_to_arabic", // wrong direction
      "entry:1:skill:meaning_recognition:field:madi", // missing direction
      "entry:1:skill:unknown_skill",
      "skill:bab_identification:entry:1",
    ]) {
      expect(isValidComponentKey(bad), bad).toBe(false);
      expect(() => parseComponentKey(bad), bad).toThrow();
    }
  });
});
