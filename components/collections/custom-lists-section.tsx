import { CreateListDialog } from "@/components/collections/create-list-dialog";
import { CustomListCard } from "@/components/collections/custom-list-card";
import { Button } from "@/components/ui/button";
import type { CustomListRecord } from "@/modules/content/db";

/** The Saved Vocabulary page's Custom lists section (Phase 14 §15). */
export function CustomListsSection({
  lists,
  nowMs,
  onCreated,
  onRenamed,
  onDeleted,
}: {
  lists: readonly CustomListRecord[];
  nowMs: number;
  onCreated: (list: CustomListRecord) => void;
  onRenamed: (list: CustomListRecord) => void;
  onDeleted: (listId: string) => void;
}) {
  return (
    <section aria-labelledby="saved-lists-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="saved-lists-heading" className="text-lg font-semibold">
          Custom lists
        </h2>
        <CreateListDialog
          trigger={
            <Button type="button" className="min-h-11">
              Create list
            </Button>
          }
          onCreated={onCreated}
        />
      </div>
      {lists.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Create a list to group vocabulary you want to practise together.
        </p>
      ) : (
        <ul
          className="grid gap-3 sm:grid-cols-2"
          data-testid="saved-custom-lists"
        >
          {lists.map((list) => (
            <li key={list.id}>
              <CustomListCard
                list={list}
                nowMs={nowMs}
                onRenamed={onRenamed}
                onDeleted={onDeleted}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
