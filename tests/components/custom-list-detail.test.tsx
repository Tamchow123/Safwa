/**
 * Custom-list detail route body (Phase 14 §16/§21/§30) — safe not-found for
 * unknown/deleted ids, entries list with remove, add-entries search dialog,
 * rename/delete reuse from T7. Real Dexie via fake-indexeddb, mirroring
 * tests/components/saved-vocabulary.test.tsx.
 */
import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const entries = built.learner.entries;

const activeState: ActiveContentState = {
  status: "ready",
  entries,
  releaseId: built.releaseId,
  contentVersion: built.learner.content_version,
  questionGeneratorVersion: built.learner.question_generator_version,
  entryCount: entries.length,
  source: "cache",
};

vi.mock("@/components/content/use-active-content", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/content/use-active-content")
    >();
  return {
    ...original,
    useActiveContent: () => ({ state: activeState, retry: vi.fn() }),
  };
});

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

import { CustomListDetail } from "@/components/collections/custom-list-detail";
import { getSafwaDb } from "@/modules/content/db";

const db = getSafwaDb();
const [entryA, entryB] = entries;

beforeEach(async () => {
  await db.lists.clear();
  await db.bookmarks.clear();
  await db.profile.clear();
  routerPush.mockClear();
});

afterAll(async () => {
  await db.delete();
});

describe("CustomListDetail — not found", () => {
  it("shows a safe not-found state for an unknown list id", async () => {
    render(<CustomListDetail listId="does-not-exist" />);
    await waitFor(() =>
      expect(screen.getByText("List not found")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert", { name: /error/i })).toBeNull();
  });

  it("shows a safe not-found state for a malformed id (JSON/path-like) without crashing", async () => {
    render(<CustomListDetail listId={'{"a":1}'} />);
    await waitFor(() =>
      expect(screen.getByText("List not found")).toBeInTheDocument(),
    );
  });

  it("shows a safe not-found state for a deleted list id", async () => {
    await db.lists.add({
      id: "list-1",
      name: "Temp",
      entryIds: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await db.lists.delete("list-1");
    render(<CustomListDetail listId="list-1" />);
    await waitFor(() =>
      expect(screen.getByText("List not found")).toBeInTheDocument(),
    );
  });
});

describe("CustomListDetail — populated list", () => {
  beforeEach(async () => {
    await db.lists.add({
      id: "list-1",
      name: "Difficult Verbs",
      entryIds: [entryA.id, entryB.id],
      createdAt: 1,
      updatedAt: 1,
    });
  });

  it("shows the name, count and entries; never exposes the raw list id in text", async () => {
    const { container } = render(<CustomListDetail listId="list-1" />);
    await screen.findByText("Difficult Verbs");
    expect(screen.getByText(/2 entries/)).toBeInTheDocument();
    const list = screen.getByTestId("custom-list-entries");
    expect(within(list).getAllByTestId("collection-entry-row")).toHaveLength(2);
    expect(container.textContent).not.toContain("list-1");
  });

  it("removing one entry leaves the other in place", async () => {
    const user = userEvent.setup();
    render(<CustomListDetail listId="list-1" />);
    const list = await screen.findByTestId("custom-list-entries");
    const rows = within(list).getAllByTestId("collection-entry-row");
    const firstRowText = rows[0].textContent;
    await user.click(within(rows[0]).getByRole("button", { name: /Remove/ }));
    await waitFor(async () => {
      const stored = await db.lists.get("list-1");
      expect(stored?.entryIds).toHaveLength(1);
    });
    const stored = await db.lists.get("list-1");
    // Whichever entry remains, it must not be the removed one.
    expect(stored?.entryIds).not.toContain(
      firstRowText?.includes(entryA.meaning) ? entryA.id : entryB.id,
    );
  });

  it("deleting the list navigates back to Saved Vocabulary", async () => {
    const user = userEvent.setup();
    render(<CustomListDetail listId="list-1" />);
    await screen.findByText("Difficult Verbs");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete list" }));
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/library/saved"),
    );
  });

  it("renaming updates the heading", async () => {
    const user = userEvent.setup();
    render(<CustomListDetail listId="list-1" />);
    await screen.findByText("Difficult Verbs");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("List name");
    await user.clear(input);
    await user.type(input, "Renamed list");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Renamed list" }),
      ).toBeInTheDocument(),
    );
  });
});

describe("CustomListDetail — add entries", () => {
  // Meanings that are neither shared with another entry nor a substring of
  // one — searching the FULL meaning then yields exactly one result, so the
  // aria-label assertions below are unambiguous regardless of what protected
  // duplicate-māḍī or near-synonym pairs exist in the dataset.
  const meaningCounts = new Map<string, number>();
  for (const e of entries) {
    meaningCounts.set(e.meaning, (meaningCounts.get(e.meaning) ?? 0) + 1);
  }
  const isUnique = (candidate: (typeof entries)[number]) =>
    meaningCounts.get(candidate.meaning) === 1 &&
    !entries.some(
      (other) =>
        other.id !== candidate.id && other.meaning.includes(candidate.meaning),
    );
  const [safeA, safeB] = entries.filter(isUnique);

  beforeEach(async () => {
    await db.lists.add({
      id: "list-1",
      name: "Verbs",
      entryIds: [safeA.id],
      createdAt: 1,
      updatedAt: 1,
    });
  });

  it("searches by meaning and marks an already-added entry", async () => {
    const user = userEvent.setup();
    render(<CustomListDetail listId="list-1" />);
    await screen.findByText("Verbs");
    await user.click(screen.getByRole("button", { name: "Add entries" }));
    const search = screen.getByLabelText("Search vocabulary");
    // fireEvent.change sets the value literally — user.type() would
    // misinterpret characters like "{" in real meaning text as the start
    // of a special-key sequence rather than literal input.
    fireEvent.change(search, { target: { value: safeA.meaning } });
    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByText(safeA.meaning)).toBeInTheDocument(),
    );
    expect(
      within(dialog).getByRole("button", {
        name: `“${safeA.meaning}” is already in this list`,
      }),
    ).toBeDisabled();
  });

  it("adding an entry from the dialog persists membership and does not duplicate rows", async () => {
    const user = userEvent.setup();
    render(<CustomListDetail listId="list-1" />);
    await screen.findByText("Verbs");
    await user.click(screen.getByRole("button", { name: "Add entries" }));
    const search = screen.getByLabelText("Search vocabulary");
    fireEvent.change(search, { target: { value: safeB.meaning } });
    const dialog = screen.getByRole("dialog");
    await user.click(
      await within(dialog).findByRole("button", {
        name: `Add “${safeB.meaning}” to this list`,
      }),
    );
    await waitFor(async () => {
      const stored = await db.lists.get("list-1");
      expect(stored?.entryIds).toContain(safeB.id);
    });
    // Also wait for the UI itself to reflect the write (the button now
    // shown as already-added), so the component's own post-write refresh
    // settles before the test ends rather than warning outside act().
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", {
          name: `“${safeB.meaning}” is already in this list`,
        }),
      ).toBeInTheDocument(),
    );
    const stored = await db.lists.get("list-1");
    expect(stored?.entryIds).toEqual(
      [...new Set(stored!.entryIds)].sort((a, b) => a - b),
    );
  });

  it("shows a discoverable notice when a search matches more than the display cap", async () => {
    const user = userEvent.setup();
    render(<CustomListDetail listId="list-1" />);
    await screen.findByText("Verbs");
    await user.click(screen.getByRole("button", { name: "Add entries" }));
    // An empty search matches every entry in the 455-entry release, well
    // over the 50-result display cap.
    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByText(/Showing the first 50 matches/),
      ).toBeInTheDocument(),
    );
  });
});
