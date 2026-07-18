/**
 * Display helpers shared by the study-mode session UIs (flashcards — Phase 8;
 * multiple-choice vocabulary quizzes — Phase 9). English chrome (field labels)
 * stays LTR; Arabic source forms are wrapped in <ArabicText> so ḥarakāt and
 * direction render correctly (docs/ARCHITECTURE.md, CLAUDE.md hard rule 5).
 */
"use client";

import { ArabicText } from "@/components/arabic-text";
import type {
  AnswerField,
  SourceQuizFormField,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import type { AttemptClock } from "@/modules/study-engine/attempts";
import { isSourceFormField } from "@/modules/study-engine/fields";

/** English labels for the source forms and meaning (UI chrome, not source Arabic). */
export const FIELD_LABELS: Record<AnswerField, string> = {
  madi: "Past (māḍī)",
  mudari: "Present (muḍāriʿ)",
  masdar: "Verbal noun (maṣdar)",
  ism_fail: "Active participle (ism al-fāʿil)",
  amr: "Command (amr)",
  nahi: "Prohibition (nahī)",
  meaning: "Meaning",
  root: "Root",
  bab: "Bāb",
  verb_type: "Verb type",
};

/** Short form names for the post-answer reveal, e.g. "This was the maṣdar form." */
export const FORM_REVEAL_NAMES: Record<SourceQuizFormField, string> = {
  madi: "māḍī",
  mudari: "muḍāriʿ",
  masdar: "maṣdar",
  ism_fail: "ism al-fāʿil",
  amr: "amr",
  nahi: "nahī",
};

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
