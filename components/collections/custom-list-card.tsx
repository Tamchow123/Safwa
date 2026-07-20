import Link from "next/link";

import { DeleteListDialog } from "@/components/collections/delete-list-dialog";
import { RenameListDialog } from "@/components/collections/rename-list-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { daysSince } from "@/lib/format-duration";
import type { CustomListRecord } from "@/modules/content/db";

/** "Updated today/yesterday/N days ago" — never an ambient clock read here. */
function formatUpdated(updatedAt: number, nowMs: number): string {
  const days = daysSince(updatedAt, nowMs);
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  return `Updated ${days} days ago`;
}

/**
 * One custom-list card (Phase 14 §15): name, entry count, last-updated
 * context, Open/Study/Rename/Delete actions. Never shows the raw list id.
 */
export function CustomListCard({
  list,
  nowMs,
  onRenamed,
  onDeleted,
}: {
  list: CustomListRecord;
  nowMs: number;
  onRenamed: (list: CustomListRecord) => void;
  onDeleted: (listId: string) => void;
}) {
  return (
    <Card data-testid="custom-list-card">
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <h3 className="font-medium">{list.name}</h3>
          <p className="text-muted-foreground text-sm">
            {list.entryIds.length}{" "}
            {list.entryIds.length === 1 ? "entry" : "entries"} ·{" "}
            {formatUpdated(list.updatedAt, nowMs)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="min-h-11">
            <Link href={`/library/saved/lists/${list.id}`}>Open list</Link>
          </Button>
          <Button asChild variant="outline" className="min-h-11">
            <Link href={`/study/custom?list=${encodeURIComponent(list.id)}`}>
              Study list
            </Link>
          </Button>
          <RenameListDialog
            trigger={
              <Button type="button" variant="ghost" className="min-h-11">
                Rename
              </Button>
            }
            list={list}
            onRenamed={onRenamed}
          />
          <DeleteListDialog
            trigger={
              <Button
                type="button"
                variant="ghost"
                className="text-destructive min-h-11"
              >
                Delete
              </Button>
            }
            list={list}
            onDeleted={onDeleted}
          />
        </div>
      </CardContent>
    </Card>
  );
}
