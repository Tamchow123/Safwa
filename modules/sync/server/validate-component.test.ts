import { describe, expect, it } from "vitest";

import type { LearnerEntry } from "@/modules/content/schema";
import type { QuestionContext } from "@/modules/study-engine/generator";

import { validateComponent } from "./validate-component";

type Eligibility = LearnerEntry["quiz_eligibility"];

function eligibility(overrides: Partial<Eligibility> = {}): Eligibility {
  return {
    madi: true,
    mudari: true,
    masdar: true,
    meaning: true,
    ism_fail: true,
    amr: true,
    nahi: true,
    bab: true,
    verb_type: true,
    root: true,
    ...overrides,
  } as Eligibility;
}

function entry(id: number, elig: Partial<Eligibility> = {}): LearnerEntry {
  return { id, quiz_eligibility: eligibility(elig) } as unknown as LearnerEntry;
}

function context(entries: LearnerEntry[]): QuestionContext {
  return {
    releaseId: "safwa-test",
    contentVersion: "2.2.0",
    questionGeneratorVersion: "1",
    entries,
    entriesById: new Map(entries.map((e) => [e.id, e])),
  } as unknown as QuestionContext;
}

const RECOGNITION_KEY =
  "entry:5:skill:meaning_recognition:field:madi:direction:arabic_to_english";
const BAB_KEY = "entry:5:skill:bab_identification";

describe("validateComponent", () => {
  it("accepts an eligible form_direction component whose key matches its fields", () => {
    const r = validateComponent(context([entry(5)]), {
      componentKey: RECOGNITION_KEY,
      entryId: 5,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.componentKey).toBe(RECOGNITION_KEY);
  });

  it("accepts an eligible entry_level component (bab_identification)", () => {
    const r = validateComponent(context([entry(5)]), {
      componentKey: BAB_KEY,
      entryId: 5,
      skillType: "bab_identification",
      sourceField: null,
      direction: null,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a natural key that does not match the submitted fields (tamper)", () => {
    const r = validateComponent(context([entry(5)]), {
      // fields say madi, key claims mudari
      componentKey:
        "entry:5:skill:meaning_recognition:field:mudari:direction:arabic_to_english",
      entryId: 5,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    });
    expect(r).toEqual({ ok: false, reasonCode: "natural_key_mismatch" });
  });

  it("rejects a structurally invalid identity (form_direction skill missing its field)", () => {
    const r = validateComponent(context([entry(5)]), {
      componentKey: RECOGNITION_KEY,
      entryId: 5,
      skillType: "meaning_recognition",
      sourceField: null,
      direction: null,
    });
    expect(r).toEqual({ ok: false, reasonCode: "natural_key_mismatch" });
  });

  it("rejects an unknown entry", () => {
    const r = validateComponent(context([entry(5)]), {
      componentKey:
        "entry:999:skill:meaning_recognition:field:madi:direction:arabic_to_english",
      entryId: 999,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    });
    expect(r).toEqual({ ok: false, reasonCode: "unknown_entry" });
  });

  it("rejects an ineligible translation field (madi not eligible)", () => {
    const r = validateComponent(context([entry(5, { madi: false })]), {
      componentKey: RECOGNITION_KEY,
      entryId: 5,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    });
    expect(r).toEqual({ ok: false, reasonCode: "ineligible_field" });
  });

  it("rejects a translation field when meaning itself is ineligible", () => {
    const r = validateComponent(context([entry(5, { meaning: false })]), {
      componentKey: RECOGNITION_KEY,
      entryId: 5,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    });
    expect(r).toEqual({ ok: false, reasonCode: "ineligible_field" });
  });

  it("rejects an ineligible entry_level fact (bab not eligible)", () => {
    const r = validateComponent(context([entry(5, { bab: false })]), {
      componentKey: BAB_KEY,
      entryId: 5,
      skillType: "bab_identification",
      sourceField: null,
      direction: null,
    });
    expect(r).toEqual({ ok: false, reasonCode: "ineligible_field" });
  });
});
