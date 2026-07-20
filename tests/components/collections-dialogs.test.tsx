/**
 * CreateListDialog and AddToListDialog (Phase 14 sections 14/15/24/30) —
 * the component reads/writes through the real browser Dexie singleton, so
 * tests seed/clear that same database (fake-indexeddb backed), mirroring
 * tests/components/register-prompt.test.tsx's convention.
 */
import "fake-indexeddb/auto";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AddToListDialog } from "@/components/collections/add-to-list-dialog";
import { CreateListDialog } from "@/components/collections/create-list-dialog";
import { getSafwaDb } from "@/modules/content/db";

const db = getSafwaDb();
const KNOWN = new Set([1, 2, 3]);

beforeEach(async () => {
  await db.lists.clear();
  await db.bookmarks.clear();
  await db.profile.clear();
});

afterAll(async () => {
  await db.delete();
});

describe("CreateListDialog", () => {
  it("creates a list and calls onCreated, then closes", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <CreateListDialog
        trigger={<button type="button">Create list</button>}
        onCreated={onCreated}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create list" }));
    await user.type(screen.getByLabelText("List name"), "Difficult Verbs");
    await user.click(screen.getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0]).toMatchObject({
      name: "Difficult Verbs",
      entryIds: [],
    });
    await waitFor(() =>
      expect(
        screen.queryByTestId("create-list-dialog"),
      ).not.toBeInTheDocument(),
    );
  });

  it("rejects an empty name without calling onCreated", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <CreateListDialog
        trigger={<button type="button">Create list</button>}
        onCreated={onCreated}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create list" }));
    expect(screen.getByRole("button", { name: "Create list" })).toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows an error, keeps the dialog open and preserves the entered text on a duplicate name", async () => {
    await db.lists.add({
      id: "existing",
      name: "Taken",
      entryIds: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <CreateListDialog
        trigger={<button type="button">Create list</button>}
        onCreated={onCreated}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create list" }));
    const input = screen.getByLabelText("List name");
    await user.type(input, "taken");
    await user.click(screen.getByRole("button", { name: "Create list" }));
    await waitFor(() =>
      expect(
        screen.getByText("You already have a list with this name."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("create-list-dialog")).toBeInTheDocument();
    expect(input).toHaveValue("taken");
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("AddToListDialog", () => {
  it("shows the empty state when there are no lists", async () => {
    const user = userEvent.setup();
    render(
      <AddToListDialog
        trigger={<button type="button">Add to list</button>}
        entryId={1}
        entryLabel="to preserve"
        lists={[]}
        knownEntryIds={KNOWN}
        onChanged={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    expect(
      screen.getByText("You don’t have any lists yet."),
    ).toBeInTheDocument();
  });

  it("reflects existing membership state via checked checkboxes", async () => {
    const user = userEvent.setup();
    render(
      <AddToListDialog
        trigger={<button type="button">Add to list</button>}
        entryId={1}
        entryLabel="to preserve"
        lists={[
          {
            id: "list-a",
            name: "Verbs",
            entryIds: [1],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "list-b",
            name: "Other",
            entryIds: [2],
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        knownEntryIds={KNOWN}
        onChanged={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it("toggling a checkbox writes the membership change and calls onChanged", async () => {
    await db.lists.add({
      id: "list-a",
      name: "Verbs",
      entryIds: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <AddToListDialog
        trigger={<button type="button">Add to list</button>}
        entryId={1}
        entryLabel="to preserve"
        lists={[
          {
            id: "list-a",
            name: "Verbs",
            entryIds: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        knownEntryIds={KNOWN}
        onChanged={onChanged}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await user.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const stored = await db.lists.get("list-a");
    expect(stored?.entryIds).toEqual([1]);
  });

  it("creates a new list from the entry and adds it atomically", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <AddToListDialog
        trigger={<button type="button">Add to list</button>}
        entryId={1}
        entryLabel="to preserve"
        lists={[]}
        knownEntryIds={KNOWN}
        onChanged={onChanged}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await user.type(screen.getByLabelText("New list"), "Fresh list");
    await user.click(screen.getByRole("button", { name: "Create & add" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const stored = await db.lists.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "Fresh list", entryIds: [1] });
  });

  it("does not repeat the whole detail page inside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <AddToListDialog
        trigger={<button type="button">Add to list</button>}
        entryId={1}
        entryLabel="to preserve"
        lists={[]}
        knownEntryIds={KNOWN}
        onChanged={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    expect(screen.queryByTestId("entry-detail")).not.toBeInTheDocument();
  });
});
