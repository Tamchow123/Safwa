/**
 * Display helpers shared by the study-mode session UIs (flashcards — Phase 8;
 * multiple-choice vocabulary quizzes — Phase 9). English chrome (field labels)
 * stays LTR; Arabic source forms are wrapped in <ArabicText> so ḥarakāt and
 * direction render correctly (docs/ARCHITECTURE.md, CLAUDE.md hard rule 5).
 */
"use client";

import { ArabicText } from "@/components/arabic-text";
import {
  SOURCE_FORM_METADATA,
  SOURCE_QUIZ_FORM_FIELDS,
} from "@/lib/form-metadata";
import type {
  AnswerField,
  SourceQuizFormField,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import type { AttemptClock } from "@/modules/study-engine/attempts";
import { isSourceFormField } from "@/modules/study-engine/fields";

/** Source-form labels DERIVED from the single shared metadata map — never a
 * second hand-maintained copy that could drift from it. */
const SOURCE_FORM_LABELS = Object.fromEntries(
  SOURCE_QUIZ_FORM_FIELDS.map((field) => [
    field,
    SOURCE_FORM_METADATA[field].label,
  ]),
) as Record<SourceQuizFormField, string>;

/**
 * English labels for every answer field (UI chrome, not source Arabic). The
 * release's `meaning` is the BASE lexical meaning of the verb entry — not a
 * literal translation of each inflected form — so it is labelled as such.
 */
export const FIELD_LABELS: Record<AnswerField, string> = {
  ...SOURCE_FORM_LABELS,
  meaning: "Base meaning",
  root: "Root",
  bab: "Bāb",
  verb_type: "Verb type",
};

/** Short transliterated form name (e.g. "maṣdar") from the shared metadata. */
export function formName(field: SourceQuizFormField): string {
  return SOURCE_FORM_METADATA[field].name;
}

/** Full form label (e.g. "Verbal noun (maṣdar)") from the shared metadata. */
export function formLabel(field: SourceQuizFormField): string {
  return SOURCE_FORM_METADATA[field].label;
}

/**
 * The browser's wall clock + IANA timezone, injected into the pure engine so it
 * never reads Date.now / the ambient locale itself. Falls back to UTC when the
 * environment does not expose a resolved timezone.
 */
export function browserClock(): AttemptClock {
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    timezone = "UTC";
  }
  return {
    now: () => Date.now(),
    timezone,
    timezoneSource: "browser_detected",
  };
}

/** Is this field an Arabic value (a source form) rather than the English meaning? */
export function isArabicField(field: AnswerField): boolean {
  return isSourceFormField(field as SourceQuizFormField);
}

/** Render a field's value, wrapping Arabic forms in <ArabicText>. */
export function FieldValue({
  entry,
  field,
  className,
}: {
  entry: LearnerEntry;
  field: AnswerField;
  className?: string;
}) {
  const value = field === "meaning" ? entry.meaning : entry[field];
  if (isArabicField(field)) {
    return (
      <ArabicText className={className ?? "text-3xl"}>
        {String(value ?? "")}
      </ArabicText>
    );
  }
  return (
    <span className={className ?? "text-2xl font-medium"}>
      {String(value ?? "")}
    </span>
  );
}
