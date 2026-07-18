import { describe, expect, it } from "vitest";

import {
  FIELD_LABELS,
  formLabel,
  formName,
} from "@/components/study/study-shared";
import { SOURCE_FORM_METADATA } from "@/lib/form-metadata";
import { SOURCE_QUIZ_FORM_FIELDS } from "@/modules/content/constants";

describe("shared source-form metadata", () => {
  it("covers every source form with a non-empty name, label and description", () => {
    for (const field of SOURCE_QUIZ_FORM_FIELDS) {
      const metadata = SOURCE_FORM_METADATA[field];
      expect(metadata.name.length, `${field} name`).toBeGreaterThan(0);
      expect(metadata.label.length, `${field} label`).toBeGreaterThan(0);
      expect(
        metadata.description.length,
        `${field} description`,
      ).toBeGreaterThan(0);
    }
    expect(Object.keys(SOURCE_FORM_METADATA).sort()).toEqual(
      [...SOURCE_QUIZ_FORM_FIELDS].sort(),
    );
  });

  it("provides the required grammatical descriptions", () => {
    expect(SOURCE_FORM_METADATA.madi.description).toBe(
      "Third-person masculine singular · past",
    );
    expect(SOURCE_FORM_METADATA.mudari.description).toBe(
      "Third-person masculine singular · present/future",
    );
    expect(SOURCE_FORM_METADATA.masdar.description).toBe("Verbal noun");
    expect(SOURCE_FORM_METADATA.ism_fail.description).toBe("Active participle");
    expect(SOURCE_FORM_METADATA.amr.description).toBe(
      "Second-person masculine singular · command",
    );
    expect(SOURCE_FORM_METADATA.nahi.description).toBe(
      "Second-person masculine singular · prohibition",
    );
  });

  it("keeps every name, label and description unique (amr vs nahy stay distinct)", () => {
    const names = SOURCE_QUIZ_FORM_FIELDS.map(
      (field) => SOURCE_FORM_METADATA[field].name,
    );
    const labels = SOURCE_QUIZ_FORM_FIELDS.map(
      (field) => SOURCE_FORM_METADATA[field].label,
    );
    const descriptions = SOURCE_QUIZ_FORM_FIELDS.map(
      (field) => SOURCE_FORM_METADATA[field].description,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("derives the study UI labels from the metadata rather than duplicating them", () => {
    for (const field of SOURCE_QUIZ_FORM_FIELDS) {
      expect(FIELD_LABELS[field]).toBe(SOURCE_FORM_METADATA[field].label);
      expect(formName(field)).toBe(SOURCE_FORM_METADATA[field].name);
      expect(formLabel(field)).toBe(SOURCE_FORM_METADATA[field].label);
    }
  });

  it("labels the release meaning field as the base meaning", () => {
    expect(FIELD_LABELS.meaning).toBe("Base meaning");
  });
});
