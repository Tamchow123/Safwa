"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { ArabicText } from "@/components/arabic-text";
import { useActiveContent } from "@/components/content/use-active-content";
import { ContentSourceNotice } from "@/components/library/content-source-notice";
import { EligibilityBadge } from "@/components/library/eligibility-badge";
import { VocabularyField } from "@/components/library/vocabulary-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SOURCE_FORM_METADATA,
  SOURCE_QUIZ_FORM_FIELDS,
} from "@/lib/form-metadata";
import type { LearnerEntry } from "@/modules/content/schema";

function BackToLibrary() {
  return (
    <Link
      href="/library"
      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-2 text-sm"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Back to library
    </Link>
  );
}

function NotFoundCard() {
  return (
    <div className="space-y-4">
      <BackToLibrary />
      <Card>
        <CardContent role="alert" className="space-y-2">
          <p className="font-medium">Entry not found</p>
          <p className="text-muted-foreground text-sm">
            There is no vocabulary entry at this address. It may have been
            mistyped — the library lists every available entry.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Detail page body. `idParam` is the raw route segment (validated here). */
export function VocabularyDetail({ idParam }: { idParam: string }) {
  const { state, retry } = useActiveContent();

  // The route id must be a positive integer (stable learner entry id).
  const valid = /^[1-9][0-9]*$/.test(idParam);
  const entryId = valid ? Number(idParam) : null;

  if (!valid) {
    return <NotFoundCard />;
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <BackToLibrary />
        <div role="status" aria-label="Loading entry" className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
          <span className="sr-only">Loading entry…</span>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-4">
        <BackToLibrary />
        <Card>
          <CardContent role="alert" className="space-y-3">
            <p className="text-destructive text-sm">{state.message}</p>
            <Button type="button" variant="outline" onClick={retry}>
              Retry loading content
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Exact-id lookup only — never positional.
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    return <NotFoundCard />;
  }

  return (
    <div className="space-y-5">
      <BackToLibrary />
      <EntryDetail entry={entry} />
      <ContentSourceNotice
        releaseId={state.releaseId}
        source={state.source}
        fallbackReason={state.fallbackReason}
        onRefresh={retry}
      />
    </div>
  );
}

function EntryDetail({ entry }: { entry: LearnerEntry }) {
  return (
    <article className="space-y-5" data-testid="entry-detail">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <ArabicText
            as="h1"
            className="text-4xl font-medium"
            data-testid="detail-madi"
          >
            {entry.madi}
          </ArabicText>
          <span className="text-muted-foreground text-sm">
            Entry #{entry.id}
          </span>
        </div>
        {/* The entry's ONE base lexical meaning — shown once, here, labelled as
            such. It is not a literal translation of each supplied form. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Base meaning
          </span>
          <EligibilityBadge eligible={entry.quiz_eligibility.meaning} />
        </div>
        <p className="text-lg" data-testid="detail-meaning">
          {entry.meaning}
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">Supplied forms</h2>
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
              <h2 className="text-base font-semibold">Morphology</h2>
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
              <h2 className="text-base font-semibold">Printed-source note</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              {entry.transcription_note}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Card>
          <CardContent className="text-muted-foreground text-sm">
            Progress tracking will appear here once study sessions are
            available.
          </CardContent>
        </Card>
        <Card>
          <CardContent className="text-muted-foreground text-sm">
            Bookmarking will become available with local learner profiles.
          </CardContent>
        </Card>
      </div>
    </article>
  );
}
