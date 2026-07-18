/**
 * The single shared metadata map for the six supplied source forms.
 *
 * Every learner-facing form label, short transliterated name and grammatical
 * description derives from here — components must not carry their own copies.
 * The entries are English/transliteration UI chrome only, never dataset Arabic
 * (CLAUDE.md hard rule 3): Arabic form VALUES always come from the learner
 * release by entry id + field.
 *
 * These descriptions exist because the release's `meaning` field is the BASE
 * lexical meaning of the verb entry (e.g. "to sleep"), not a literal English
 * translation of each inflected form. The grammatical description tells the
 * learner what the displayed Arabic form actually is; exact form-specific
 * English glosses would require separately verified content and are deferred.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import {
  SOURCE_QUIZ_FORM_FIELDS,
  type SourceQuizFormField,
} from "@/modules/content/constants";

export type SourceFormMetadata = {
  /** Short transliterated name used inline in prose, e.g. "māḍī". */
  name: string;
  /** Full label for captions and option lists, e.g. "Past (māḍī)". */
  label: string;
  /** Learner-facing grammatical description of what the form is. */
  description: string;
};

export const SOURCE_FORM_METADATA: Readonly<
  Record<SourceQuizFormField, SourceFormMetadata>
> = {
  madi: {
    name: "māḍī",
    label: "Past (māḍī)",
    description: "Third-person masculine singular · past",
  },
  mudari: {
    name: "muḍāriʿ",
    label: "Present (muḍāriʿ)",
    description: "Third-person masculine singular · present/future",
  },
  masdar: {
    name: "maṣdar",
    label: "Verbal noun (maṣdar)",
    description: "Verbal noun",
  },
  ism_fail: {
    name: "ism al-fāʿil",
    label: "Active participle (ism al-fāʿil)",
    description: "Active participle",
  },
  amr: {
    name: "amr",
    label: "Command (amr)",
    description: "Second-person masculine singular · command",
  },
  nahi: {
    name: "nahī",
    label: "Prohibition (nahī)",
    description: "Second-person masculine singular · prohibition",
  },
};

/** The metadata for one source form (typed convenience accessor). */
export function sourceFormMetadata(
  field: SourceQuizFormField,
): SourceFormMetadata {
  return SOURCE_FORM_METADATA[field];
}

/** The source-form fields in canonical order (re-export for UI iteration). */
export { SOURCE_QUIZ_FORM_FIELDS };
