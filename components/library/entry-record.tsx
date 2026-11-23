import { VocabularyField } from "@/components/library/vocabulary-field";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SOURCE_FORM_METADATA,
  SOURCE_QUIZ_FORM_FIELDS,
} from "@/lib/form-metadata";
import type { LearnerEntry } from "@/modules/content/schema";

/**
 * An entry's read-only record — its supplied forms, morphology and
 * printed-source note — shared by the entry page and the in-session entry
 * dialog (Phase 18.5), so the two can never show a word differently.
 * `headingLevel` keeps the outline correct under each one's own title.
 */
export function EntryRecord({
  entry,
  headingLevel = "h2",
}: {
  entry: LearnerEntry;
  headingLevel?: "h2" | "h3";
}) {
  const Heading = headingLevel;
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <Heading className="text-base font-semibold">
                Supplied forms
              </Heading>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Each supplied form with its shared-metadata label and
                grammatical description. The base meaning is NOT repeated here
                (it appears once in the header) and no English rendering of any
                individual form is generated from it. */}
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {SOURCE_QUIZ_FORM_FIELDS.map((field) => (
                <VocabularyField
                  key={field}
                  label={SOURCE_FORM_METADATA[field].label}
                  description={SOURCE_FORM_METADATA[field].description}
                  value={entry[field]}
                  arabic
                  eligible={entry.quiz_eligibility[field]}
                  // The header's madi already carries data-testid="detail-madi".
                  testId={field === "madi" ? undefined : `detail-${field}`}
                />
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <Heading className="text-base font-semibold">Morphology</Heading>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <VocabularyField
                label="Root"
                value={entry.root}
                arabic
                eligible={entry.quiz_eligibility.root}
                unavailableText="Not available — awaiting verification"
                testId="detail-root"
              />
              <VocabularyField
                label="Bab"
                value={entry.bab}
                eligible={entry.quiz_eligibility.bab}
              />
              <VocabularyField
                label="Bab (Arabic pair)"
                value={entry.bab_arabic}
                arabic
                eligible={entry.quiz_eligibility.bab}
                testId="detail-bab-arabic"
              />
              <VocabularyField
                label="Verb type"
                value={entry.verb_type}
                eligible={entry.quiz_eligibility.verb_type}
                testId="detail-verb-type"
              />
              <VocabularyField
                label="Verb type (Arabic)"
                value={entry.verb_type_arabic}
                arabic
                eligible={entry.quiz_eligibility.verb_type}
              />
              <VocabularyField
                label="Book page"
                value={`${entry.book_page}`}
                testId="detail-book-page"
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      {entry.transcription_note ? (
        <Card data-testid="detail-note">
          <CardHeader>
            <CardTitle>
              <Heading className="text-base font-semibold">
                Printed-source note
              </Heading>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              {entry.transcription_note}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
