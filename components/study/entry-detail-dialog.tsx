"use client";

import { ArabicText } from "@/components/arabic-text";
import { EntryProgressCard } from "@/components/library/entry-progress";
import { EntryRecord } from "@/components/library/entry-record";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { LearnerEntry } from "@/modules/content/schema";

/**
 * "View full entry" during a session (Phase 18.5): the entry opens OVER the
 * session instead of navigating away from it, so the session — which lives
 * only in its page — carries on where it was when the dialog closes (focus
 * returns to this trigger). The same record and progress card as the entry
 * page.
 */
export function EntryDetailDialog({ entry }: { entry: LearnerEntry }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="link"
          className="min-h-11"
          data-testid="entry-detail-link"
        >
          View full entry
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
        data-testid="entry-detail-dialog"
        // The dialog renders in a portal, but React still bubbles its events
        // through the session's tree — where the flashcard's ← / → keys grade
        // the card. Keys pressed in the dialog stay in the dialog.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>
            <ArabicText className="text-3xl font-medium">
              {entry.madi}
            </ArabicText>
          </DialogTitle>
          <DialogDescription>
            Base meaning: {entry.meaning} · Entry #{entry.id}
          </DialogDescription>
        </DialogHeader>
        <EntryRecord entry={entry} headingLevel="h3" />
        <EntryProgressCard entry={entry} headingLevel="h3" />
      </DialogContent>
    </Dialog>
  );
}
