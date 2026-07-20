/**
 * Pure custom-list record construction (Phase 14, docs/phases/phases-14.md
 * sections 6/8.2/8.4/27).
 */
import { describe, expect, it } from "vitest";

import {
  buildListRecord,
  withEntryAdded,
  withEntryRemoved,
  withMembership,
  withRenamedList,
} from "@/modules/collections/lists";

describe("buildListRecord", () => {
  it("uses the injected id and clock, not an ambient source", () => {
    const record = buildListRecord({
      id: "list-1",
      name: "Difficult Verbs",
      now: 1_000,
    });
    expect(record).toEqual({
      id: "list-1",
      name: "Difficult Verbs",
      entryIds: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("canonicalises the initial membership", () => {
    const record = buildListRecord({
      id: "list-1",
      name: "Verbs",
      entryIds: [30, 2, 30, 9],
      now: 1_000,
    });
    expect(record.entryIds).toEqual([2, 9, 30]);
  });

  it("is a stable, deterministic function of fixed inputs", () => {
    const params = {
      id: "list-1",
      name: "  Difficult   Verbs  ",
      entryIds: [9, 2],
      now: 1_000,
    };
    expect(buildListRecord(params)).toEqual(buildListRecord(params));
  });

  it("has updatedAt >= createdAt on creation (equal)", () => {
    const record = buildListRecord({ id: "list-1", name: "Verbs", now: 42 });
    expect(record.updatedAt).toBeGreaterThanOrEqual(record.createdAt);
  });

  it("cleans the display name the same way validation.ts does", () => {
    const record = buildListRecord({
      id: "list-1",
      name: "  difficult   verbs  ",
      now: 1_000,
    });
    expect(record.name).toBe("difficult verbs");
  });
});

describe("withRenamedList", () => {
  const base = buildListRecord({ id: "list-1", name: "Old name", now: 1 });

  it("updates the name and bumps updatedAt, preserving createdAt", () => {
    const renamed = withRenamedList(base, "New name", 2);
    expect(renamed.name).toBe("New name");
    expect(renamed.createdAt).toBe(1);
    expect(renamed.updatedAt).toBe(2);
  });

  it("cleans the new name", () => {
    const renamed = withRenamedList(base, "  new   name  ", 2);
    expect(renamed.name).toBe("new name");
  });
});

describe("withMembership / withEntryAdded / withEntryRemoved", () => {
  const base = buildListRecord({
    id: "list-1",
    name: "Verbs",
    entryIds: [7],
    now: 1,
  });

  it("withMembership replaces and canonicalises membership", () => {
    const next = withMembership(base, [30, 7, 30], 2);
    expect(next.entryIds).toEqual([7, 30]);
    expect(next.updatedAt).toBe(2);
  });

  it("withEntryAdded adds a new entry", () => {
    const next = withEntryAdded(base, 9, 2);
    expect(next.entryIds).toEqual([7, 9]);
  });

  it("adding an existing entry is idempotent", () => {
    const next = withEntryAdded(base, 7, 2);
    expect(next.entryIds).toEqual([7]);
  });

  it("withEntryRemoved removes an entry", () => {
    const twoEntries = withEntryAdded(base, 9, 2);
    const next = withEntryRemoved(twoEntries, 7, 3);
    expect(next.entryIds).toEqual([9]);
  });

  it("removing a missing entry is idempotent (membership unchanged)", () => {
    const next = withEntryRemoved(base, 999, 2);
    expect(next.entryIds).toEqual([7]);
  });

  it("a list can contain both members of a protected duplicate group", () => {
    // Protected duplicate-madi group ids (262, 275).
    const withDuplicates = withMembership(base, [262, 275], 2);
    expect(withDuplicates.entryIds).toEqual([262, 275]);
    const removedOne = withEntryRemoved(withDuplicates, 262, 3);
    expect(removedOne.entryIds).toEqual([275]);
  });
});
