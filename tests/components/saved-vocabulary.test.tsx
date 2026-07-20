/**
 * Saved Vocabulary page (Phase 14 §15/§30) — bookmarks section, custom
 * lists section, empty states, list card actions. The collections hook
 * reads/writes through the real browser Dexie singleton (fake-indexeddb
 * backed), mirroring tests/components/collections-dialogs.test.tsx.
 */
import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";

import { render, screen, waitFor, within } from "@testing-library/react";
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

import { SavedVocabularyClient } from "@/components/collections/saved-vocabulary-client";
import { getSafwaDb } from "@/modules/content/db";

const db = getSafwaDb();
const [entryA, entryB] = entries;

beforeEach(async () => {
  await db.bookmarks.clear();
  await db.lists.clear();
  await db.profile.clear();
});

afterAll(async () => {
  await db.delete();
});

describe("SavedVocabularyClient — empty states", () => {
  it("shows both empty states as ordinary content, not errors", async () => {
    render(<SavedVocabularyClient />);
    await waitFor(() =>
      expect(
        screen.getByText(
          /Save words from the Library or after a study session/,
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Create a list to group vocabulary/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SavedVocabularyClient — bookmarks section", () => {
  it("lists bookmarked entries newest-first with a working remove action", async () => {
    await db.bookmarks.bulkAdd([
      { entryId: entryA.id, createdAt: 100 },
      { entryId: entryB.id, createdAt: 200 },
    ]);
    render(<SavedVocabularyClient />);
    const list = await screen.findByTestId("saved-bookmarks-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // entryB (createdAt 200) is newer, so it appears first.
    expect(items[0]).toHaveTextContent(entryB.meaning);
    expect(items[1]).toHaveTextContent(entryA.meaning);

    const user = userEvent.setup();
    const removeButtons = within(list).getAllByTestId("bookmark-toggle");
    await user.click(removeButtons[0]);
    await waitFor(async () => {
      expect(await db.bookmarks.get(entryB.id)).toBeUndefined();
    });
  });

  it("never exposes a raw list id anywhere in the page", async () => {
    await db.lists.add({
      id: "11111111-1111-7111-8111-111111111111",
      name: "Verbs",
      entryIds: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const { container } = render(<SavedVocabularyClient />);
    await screen.findByText("Verbs");
    expect(container.textContent).not.toContain(
      "11111111-1111-7111-8111-111111111111",
    );
  });

  it("silently excludes a stale bookmark whose entry is not in the active release, without crashing", async () => {
    const staleEntryId = Math.max(...entries.map((e) => e.id)) + 1;
    await db.bookmarks.bulkAdd([
      { entryId: staleEntryId, createdAt: 50 },
      { entryId: entryA.id, createdAt: 100 },
    ]);
    render(<SavedVocabularyClient />);
    const list = await screen.findByTestId("saved-bookmarks-list");
    const items = within(list).getAllByRole("listitem");
    // Only the resolvable entry renders; the stale id produces no broken row.
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(entryA.meaning);
    expect(screen.getByTestId("saved-bookmarks-count")).toHaveTextContent("1");
  });
});

describe("SavedVocabularyClient — custom lists section", () => {
  it("shows list cards with name, count and updated context", async () => {
    await db.lists.add({
      id: "list-1",
      name: "Difficult Verbs",
      entryIds: [entryA.id, entryB.id],
      createdAt: 1,
      updatedAt: Date.now(),
    });
    render(<SavedVocabularyClient />);
    const card = await screen.findByTestId("custom-list-card");
    expect(within(card).getByText("Difficult Verbs")).toBeInTheDocument();
    expect(within(card).getByText(/2 entries/)).toBeInTheDocument();
    expect(within(card).getByText(/Updated today/)).toBeInTheDocument();
    expect(
      within(card).getByRole("link", { name: "Open list" }),
    ).toHaveAttribute("href", "/library/saved/lists/list-1");
    expect(
      within(card).getByRole("link", { name: "Study list" }),
    ).toHaveAttribute("href", "/study/custom?list=list-1");
  });

  it("creating a list from the section adds a new card", async () => {
    const user = userEvent.setup();
    render(<SavedVocabularyClient />);
    await screen.findByText(/Create a list to group vocabulary/);
    await user.click(screen.getByRole("button", { name: "Create list" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("List name"), "New list");
    await user.click(
      within(dialog).getByRole("button", { name: "Create list" }),
    );
    await waitFor(() =>
      expect(screen.getByText("New list")).toBeInTheDocument(),
    );
  });

  it("renaming a list from its card updates the displayed name", async () => {
    await db.lists.add({
      id: "list-1",
      name: "Old name",
      entryIds: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const user = userEvent.setup();
    render(<SavedVocabularyClient />);
    await screen.findByText("Old name");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("List name");
    await user.clear(input);
    await user.type(input, "New name");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(screen.getByText("New name")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Old name")).not.toBeInTheDocument();
    const stored = await db.lists.get("list-1");
    expect(stored?.name).toBe("New name");
  });

  it("deleting a list from its card removes the card, naming the list in the confirmation", async () => {
    await db.lists.add({
      id: "list-1",
      name: "Revision week",
      entryIds: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const user = userEvent.setup();
    render(<SavedVocabularyClient />);
    await screen.findByText("Revision week");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(
      screen.getByRole("heading", { name: "Delete “Revision week”?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete list" }));
    await waitFor(() =>
      expect(screen.queryByText("Revision week")).not.toBeInTheDocument(),
    );
    expect(await db.lists.get("list-1")).toBeUndefined();
  });

  it("deleting a list does not remove an independently bookmarked entry from that list", async () => {
    await db.lists.add({
      id: "list-1",
      name: "Revision week",
      entryIds: [entryA.id],
      createdAt: 1,
      updatedAt: 1,
    });
    await db.bookmarks.add({ entryId: entryA.id, createdAt: 1 });
    const user = userEvent.setup();
    render(<SavedVocabularyClient />);
    await screen.findByText("Revision week");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete list" }));
    await waitFor(() =>
      expect(screen.queryByText("Revision week")).not.toBeInTheDocument(),
    );
    expect(await db.bookmarks.get(entryA.id)).toBeDefined();
  });
});
