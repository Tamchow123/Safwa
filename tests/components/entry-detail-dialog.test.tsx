import { readFileSync } from "node:fs";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";

// jsdom has no IndexedDB: the progress card's database handle is a stand-in
// and its one read returns a learner with no history.
vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});
vi.mock("@/modules/study-session/persistence", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/modules/study-session/persistence")
    >();
  return { ...original, readComponentsSchedulingState: async () => [] };
});

import { EntryDetailDialog } from "@/components/study/entry-detail-dialog";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const entry = built.learner.entries[0];

describe("EntryDetailDialog (Phase 18.5)", () => {
  it("opens the entry over the session: its record and its progress, under the dialog's own title", async () => {
    render(<EntryDetailDialog entry={entry} />);
    await userEvent.click(
      screen.getByRole("button", { name: "View full entry" }),
    );
    const dialog = await screen.findByRole("dialog");
    const title = within(dialog).getByRole("heading", { level: 2 });
    expect(title.textContent).toBe(entry.madi);
    expect(title.querySelector('[lang="ar"][dir="rtl"]')).not.toBeNull();
    expect(dialog).toHaveTextContent(entry.meaning);
    expect(within(dialog).getByTestId("detail-mudari").textContent).toContain(
      entry.mudari,
    );
    await within(dialog).findByTestId("entry-progress-chain");
    // The outline nests under the title: one h2, every section an h3.
    expect(within(dialog).getAllByRole("heading", { level: 2 })).toHaveLength(
      1,
    );
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(
      expect.arrayContaining(["Supplied forms", "Morphology", "Your progress"]),
    );
  });

  it("keys pressed in the dialog never reach the session underneath, and closing returns focus", async () => {
    // The flashcard session grades on ← / → from a key handler on its root;
    // the dialog's portal would otherwise bubble keys there through React.
    const sessionKeys = vi.fn();
    render(
      <div onKeyDown={sessionKeys}>
        <EntryDetailDialog entry={entry} />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "View full entry" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{ArrowRight}{ArrowLeft}");
    expect(sessionKeys).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    // Outside the dialog, the session's keys work as before.
    await userEvent.keyboard("{ArrowRight}");
    expect(sessionKeys).toHaveBeenCalledTimes(1);
  });
});
