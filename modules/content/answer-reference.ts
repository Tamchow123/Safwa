/**
 * Stable objective-answer references (ADR-006). An answer is always a
 * reference to an entry's field — never copied text — so the server can
 * resolve both selected and canonical answers from the assessment manifest.
 * String form: `entry:<entry-id>:field:<field>`. Browser-safe.
 */
import { z } from "zod";

import { ANSWER_FIELDS, type AnswerField } from "@/modules/content/constants";

export const answerReferenceSchema = z.strictObject({
  entryId: z.number().int().min(1),
  field: z.enum(ANSWER_FIELDS),
});
export type AnswerReference = z.infer<typeof answerReferenceSchema>;

const ANSWER_REFERENCE_PATTERN = /^entry:([1-9][0-9]*):field:([a-z_]+)$/;

/** Deterministic string form of an answer reference. */
export function serializeAnswerReference(reference: AnswerReference): string {
  const parsed = answerReferenceSchema.parse(reference);
  return `entry:${parsed.entryId}:field:${parsed.field}`;
}

/** Parse and validate the string form. Throws on any invalid input. */
export function parseAnswerReference(value: string): AnswerReference {
  const match = ANSWER_REFERENCE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`invalid answer reference: ${JSON.stringify(value)}`);
  }
  return answerReferenceSchema.parse({
    entryId: Number(match[1]),
    field: match[2] as AnswerField,
  });
}

export function isAnswerField(value: string): value is AnswerField {
  return (ANSWER_FIELDS as readonly string[]).includes(value);
}
