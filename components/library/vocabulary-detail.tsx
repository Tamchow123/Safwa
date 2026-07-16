"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { ArabicText } from "@/components/arabic-text";
import { useActiveContent } from "@/components/content/use-active-content";
import { ContentSourceNotice } from "@/components/library/content-source-notice";
import { VocabularyField } from "@/components/library/vocabulary-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
            as="p"
            className="text-4xl font-medium"
            data-testid="detail-madi"
          >
            {entry.madi}
          </ArabicText>
          <span className="text-muted-foreground text-sm">
            Entry #{entry.id}
          </span>
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
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <VocabularyField
                label="Madi (past)"
                value={entry.madi}
                arabic
                eligible={entry.quiz_eligibility.madi}
              />
              <VocabularyField
                label="Mudari (present)"
                value={entry.mudari}
                arabic
                eligible={entry.quiz_eligibility.mudari}
                testId="detail-mudari"
              />
              <VocabularyField
                label="Masdar"
                value={entry.masdar}
                arabic
                eligible={entry.quiz_eligibility.masdar}
                testId="detail-masdar"
              />
              <VocabularyField
                label="Ism al-fail"
                value={entry.ism_fail}
                arabic
                eligible={entry.quiz_eligibility.ism_fail}
              />
              <VocabularyField
                label="Amr (command)"
                value={entry.amr}
                arabic
                eligible={entry.quiz_eligibility.amr}
              />
              <VocabularyField
                label="Nahy (prohibition)"
                value={entry.nahi}
                arabic
                eligible={entry.quiz_eligibility.nahi}
              />
              <VocabularyField
                label="Meaning"
                value={entry.meaning}
                eligible={entry.quiz_eligibility.meaning}
              />
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
