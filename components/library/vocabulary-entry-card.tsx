import Link from "next/link";

import { ArabicText } from "@/components/arabic-text";
import { Badge } from "@/components/ui/badge";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  isFullyQuizzable,
  notQuizzedFieldCount,
} from "@/modules/content/query";

/**
 * One virtualised library result. Shows enough to distinguish entries —
 * including the protected duplicate-madi groups, which differ in mudari
 * and/or bab. All Arabic renders through <ArabicText>; every value comes
 * from the verified learner release.
 */
export function VocabularyEntryCard({ entry }: { entry: LearnerEntry }) {
  const fully = isFullyQuizzable(entry);
  return (
    <Link
      href={`/library/${entry.id}`}
      aria-label={`${entry.meaning} — entry ${entry.id}`}
      data-testid="entry-card"
      data-entry-id={entry.id}
      data-bab={entry.bab}
      data-verb-type={entry.verb_type}
      data-book-page={entry.book_page}
      className="bg-card hover:border-primary/40 focus-visible:border-primary block min-h-11 rounded-xl border p-4 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <ArabicText className="text-2xl font-medium">{entry.madi}</ArabicText>
          <ArabicText className="text-muted-foreground text-lg">
            {entry.mudari}
          </ArabicText>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          #{entry.id}
        </span>
      </div>
      <p className="mt-1 text-sm">{entry.meaning}</p>
      <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="gap-1 font-normal">
          {entry.bab}
          <ArabicText className="text-[11px]">{entry.bab_arabic}</ArabicText>
        </Badge>
        <Badge variant="outline" className="font-normal">
          {entry.verb_type}
        </Badge>
        <Badge variant="outline" className="font-normal">
          p. {entry.book_page}
        </Badge>
        <Badge
          variant={fully ? "secondary" : "outline"}
          className="font-normal"
        >
          {fully
            ? "Quizzed in all fields"
            : `${notQuizzedFieldCount(entry)} field(s) not quizzed`}
        </Badge>
      </div>
    </Link>
  );
}
