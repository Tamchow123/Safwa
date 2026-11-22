import { readFileSync } from "node:fs";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";
import type { StoredComponentState } from "@/modules/study-session/mixed";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const entries = built.learner.entries;

const activeState: { current: ActiveContentState } = {
  current: {
    status: "ready",
    entries,
    releaseId: built.releaseId,
    contentVersion: built.learner.content_version,
    questionGeneratorVersion: built.learner.question_generator_version,
    entryCount: entries.length,
    source: "cache",
  },
};

vi.mock("@/components/content/use-active-content", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/content/use-active-content")
    >();
  return {
    ...original,
    useActiveContent: () => ({ state: activeState.current, retry: vi.fn() }),
  };
});

// jsdom has no IndexedDB: the card's database handle is a stand-in, and its
// ONE read is mocked below.
vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});

// The progress card's ONE read. Each test sets the owner's stored state; the
// default is a learner with no study history.
const readComponentsSchedulingState = vi.fn<
  (
    db: unknown,
    owner: string | null,
    componentKeys: readonly string[],
  ) => Promise<StoredComponentState[]>
>(async () => []);
vi.mock("@/modules/study-session/persistence", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/modules/study-session/persistence")
    >();
  return {
    ...original,
    readComponentsSchedulingState: (
      db: unknown,
      owner: string | null,
      componentKeys: readonly string[],
    ) => readComponentsSchedulingState(db, owner, componentKeys),
  };
});

/** A promise the test settles by hand — to hold a read in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function regainVisibility() {
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

vi.mock("@/components/collections/use-collections", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/collections/use-collections")
    >();
  return {
    ...original,
    useCollections: () => ({
      state: {
        status: "ready",
        snapshot: {
          bookmarks: [],
          lists: [],
          bookmarkedEntryIds: new Set<number>(),
          listsById: new Map(),
        },
      },
      refresh: vi.fn(),
    }),
  };
});

import { contentSourceLabel } from "@/components/content/use-active-content";
import { ContentSourceNotice } from "@/components/library/content-source-notice";
import { EligibilityBadge } from "@/components/library/eligibility-badge";
import { LibraryToolbar } from "@/components/library/library-toolbar";
import { VocabularyDetail } from "@/components/library/vocabulary-detail";
import { VocabularyEntryCard } from "@/components/library/vocabulary-entry-card";
import { VocabularyField } from "@/components/library/vocabulary-field";
import {
  SOURCE_FORM_METADATA,
  SOURCE_QUIZ_FORM_FIELDS,
} from "@/lib/form-metadata";
import {
  DEFAULT_LIBRARY_QUERY,
  deriveLibraryFilterOptions,
} from "@/modules/content/query";
import { newCard, reviewCard } from "@/modules/scheduler/fsrs";
import { deriveComponentsForEntry } from "@/modules/study-engine/components";
import { chainForEntry } from "@/modules/study-session/skill-chain";

const INTERNAL_FIELD_NAMES = [
  "root_provenance",
  "data_quality",
  "requires_manual_review",
  "blocked_by",
  "additional_forms",
  "generated_additional_forms",
  "mazid_fih_patterns",
  "mazid_fih_entries",
  "internally_validated",
  "needs_review",
];

describe("VocabularyEntryCard", () => {
  const entry = entries[0];

  it("renders Arabic values with lang and dir through ArabicText", () => {
    const { container } = render(
      <VocabularyEntryCard
        entry={entry}
        bookmarked={false}
        onToggleBookmark={vi.fn()}
      />,
    );
    const arabicElements = container.querySelectorAll('[lang="ar"][dir="rtl"]');
    expect(arabicElements.length).toBeGreaterThanOrEqual(3); // madi, mudari, bab pair
    expect(arabicElements[0].textContent).toContain(entry.madi);
  });

  it("shows madi, mudari, meaning, bab, verb type and page", () => {
    const { container } = render(
      <VocabularyEntryCard
        entry={entry}
        bookmarked={false}
        onToggleBookmark={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(entry.mudari);
    expect(container.textContent).toContain(entry.meaning);
    expect(container.textContent).toContain(entry.bab);
    expect(container.textContent).toContain(entry.verb_type);
    expect(container.textContent).toContain(`p. ${entry.book_page}`);
  });

  it("links to the detail route with a descriptive name and data attributes", () => {
    render(
      <VocabularyEntryCard
        entry={entry}
        bookmarked={false}
        onToggleBookmark={vi.fn()}
      />,
    );
    const link = screen.getByRole("link", {
      name: `${entry.meaning} — entry ${entry.id}`,
    });
    expect(link).toHaveAttribute("href", `/library/${entry.id}`);
    expect(link).toHaveAttribute("data-bab", entry.bab);
    expect(link).toHaveAttribute("data-verb-type", entry.verb_type);
    expect(link).toHaveAttribute("data-book-page", String(entry.book_page));
  });

  it("summarises eligibility for a partially quizzable entry", () => {
    const partial = entries.find((candidate) => candidate.id === 30)!; // masdar disabled
    const { container } = render(
      <VocabularyEntryCard
        entry={partial}
        bookmarked={false}
        onToggleBookmark={vi.fn()}
      />,
    );
    expect(container.textContent).toMatch(/field\(s\) not in quizzes/);
  });

  it("does not leak internal metadata", () => {
    const { container } = render(
      <VocabularyEntryCard
        entry={entry}
        bookmarked={false}
        onToggleBookmark={vi.fn()}
      />,
    );
    for (const forbidden of INTERNAL_FIELD_NAMES) {
      expect(container.innerHTML).not.toContain(forbidden);
    }
  });

  it("the bookmark toggle is a sibling of the link, never nested inside it", () => {
    render(
      <VocabularyEntryCard
        entry={entry}
        bookmarked={false}
        onToggleBookmark={vi.fn()}
      />,
    );
    const link = screen.getByRole("link", {
      name: `${entry.meaning} — entry ${entry.id}`,
    });
    const toggle = screen.getByTestId("bookmark-toggle");
    expect(link.contains(toggle)).toBe(false);
    expect(toggle.contains(link)).toBe(false);
  });

  it("clicking the bookmark toggle does not navigate and does not trigger the link", async () => {
    const user = userEvent.setup();
    const onToggleBookmark = vi.fn().mockResolvedValue(undefined);
    render(
      <VocabularyEntryCard
        entry={entry}
        bookmarked={false}
        onToggleBookmark={onToggleBookmark}
      />,
    );
    await user.click(screen.getByTestId("bookmark-toggle"));
    expect(onToggleBookmark).toHaveBeenCalledTimes(1);
  });

  it("reflects the bookmarked prop via the toggle's pressed state", () => {
    render(
      <VocabularyEntryCard
        entry={entry}
        bookmarked={true}
        onToggleBookmark={vi.fn()}
      />,
    );
    expect(screen.getByTestId("bookmark-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("EligibilityBadge and VocabularyField", () => {
  it("badge is textual, and says whether the field is used in quizzes — not whether it was asked", () => {
    const { rerender } = render(<EligibilityBadge eligible />);
    expect(screen.getByText("In quizzes")).toBeInTheDocument();
    expect(screen.queryByText(/quizzed/i)).not.toBeInTheDocument();
    rerender(<EligibilityBadge eligible={false} />);
    expect(screen.getByText("Not in quizzes")).toBeInTheDocument();
    expect(screen.queryByText(/quizzed/i)).not.toBeInTheDocument();
  });

  it("field renders Arabic values through ArabicText", () => {
    const { container } = render(
      <dl>
        <VocabularyField label="Madi" value={entries[0].madi} arabic eligible />
      </dl>,
    );
    const arabic = container.querySelector('[lang="ar"][dir="rtl"]');
    expect(arabic?.textContent).toContain(entries[0].madi);
    expect(screen.getByText("In quizzes")).toBeInTheDocument();
  });

  it("field renders the unavailable state when the value is missing", () => {
    render(
      <dl>
        <VocabularyField
          label="Root"
          eligible={false}
          unavailableText="Not available — awaiting verification"
        />
      </dl>,
    );
    expect(
      screen.getByText("Not available — awaiting verification"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not in quizzes")).toBeInTheDocument();
  });
});

describe("LibraryToolbar", () => {
  const options = deriveLibraryFilterOptions(entries);

  it("has visible labels and default states for every control", () => {
    render(
      <LibraryToolbar
        query={DEFAULT_LIBRARY_QUERY}
        options={options}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Search vocabulary")).toHaveValue("");
    for (const label of [
      "Bab",
      "Verb type",
      "Book page",
      "Quiz eligibility",
      "Sort by",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Reset filters" }),
    ).toBeInTheDocument();
  });

  it("reports search changes with replace-history semantics", async () => {
    const onChange = vi.fn();
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(
      <LibraryToolbar
        query={DEFAULT_LIBRARY_QUERY}
        options={options}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText("Search vocabulary"), "a");
    expect(onChange).toHaveBeenCalledWith({ search: "a" }, "replace");
  });
});

describe("ContentSourceNotice", () => {
  it("labels fallback without claiming offline for integrity failures", () => {
    render(
      <ContentSourceNotice
        releaseId="safwa-test"
        source="fallback-cache"
        fallbackReason="checksum-mismatch"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByTestId("content-source")).toHaveTextContent(
      "using the previous verified cached release",
    );
    expect(screen.getByTestId("content-source")).not.toHaveTextContent(
      "offline",
    );
  });

  it("labels genuine network fallbacks as offline", () => {
    expect(contentSourceLabel("fallback-cache", "pointer-unavailable")).toBe(
      "using the previous verified cached release (offline)",
    );
    expect(contentSourceLabel("cache")).toBe("served from verified cache");
  });
});

describe("VocabularyDetail", () => {
  it("renders the entry title as the level-one page heading", () => {
    const entry = entries.find((candidate) => candidate.id === 1)!;
    render(<VocabularyDetail idParam="1" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain(entry.madi);
    expect(heading).toHaveAttribute("lang", "ar");
    expect(heading).toHaveAttribute("dir", "rtl");
  });

  it("maps every field to its own eligibility boolean (entry 30)", () => {
    // Entry 30: masdar is quiz-ineligible while other fields stay in quizzes.
    render(<VocabularyDetail idParam="30" />);
    const masdarField = screen.getByTestId("detail-masdar");
    expect(within(masdarField).getByText("Not in quizzes")).toBeInTheDocument();
    const mudariField = screen.getByTestId("detail-mudari");
    expect(within(mudariField).getByText("In quizzes")).toBeInTheDocument();
  });

  it("shows the base meaning exactly once, labelled as a base meaning", () => {
    const entry = entries.find((candidate) => candidate.id === 1)!;
    const { container } = render(<VocabularyDetail idParam="1" />);
    expect(screen.getByText("Base meaning")).toBeInTheDocument();
    expect(screen.getByTestId("detail-meaning").textContent).toBe(
      entry.meaning,
    );
    // The gloss appears exactly ONCE on the page — it is never repeated as a
    // per-form "translation" and never expanded into generated English
    // conjugations ("he slept", "do not sleep").
    const occurrences = container.textContent!.split(entry.meaning).length - 1;
    expect(occurrences).toBe(1);
  });

  it("describes each supplied form with the shared metadata (label + description)", () => {
    render(<VocabularyDetail idParam="1" />);
    const descriptions = screen
      .getAllByTestId("field-description")
      .map((element) => element.textContent);
    // One grammatical description per supplied form, sourced from the single
    // shared metadata map — not duplicated per component.
    expect(descriptions).toHaveLength(SOURCE_QUIZ_FORM_FIELDS.length);
    for (const field of SOURCE_QUIZ_FORM_FIELDS) {
      expect(descriptions).toContain(SOURCE_FORM_METADATA[field].description);
      expect(
        screen.getByText(SOURCE_FORM_METADATA[field].label),
      ).toBeInTheDocument();
    }
  });

  it("shows the transcription note only when present", () => {
    const noteEntry = entries.find((entry) => entry.transcription_note)!;
    render(<VocabularyDetail idParam={String(noteEntry.id)} />);
    expect(screen.getByTestId("detail-note").textContent).toContain(
      noteEntry.transcription_note!,
    );
  });

  it("omits the note section when absent", () => {
    render(<VocabularyDetail idParam="1" />);
    expect(screen.queryByTestId("detail-note")).toBeNull();
  });

  it("shows unavailable root and not-quizzed verb type for entry 369", () => {
    render(<VocabularyDetail idParam="369" />);
    const rootField = screen.getByTestId("detail-root");
    expect(rootField.textContent).toContain(
      "Not available — awaiting verification",
    );
    expect(within(rootField).getByText("Not in quizzes")).toBeInTheDocument();
    expect(rootField.querySelector('[lang="ar"]')).toBeNull();
    const verbTypeField = screen.getByTestId("detail-verb-type");
    expect(
      within(verbTypeField).getByText("Not in quizzes"),
    ).toBeInTheDocument();
  });

  it("shows real progress, not a placeholder, and real collection controls instead of the retired bookmark placeholder", async () => {
    const { container } = render(<VocabularyDetail idParam="1" />);
    const card = await screen.findByTestId("entry-progress-chain");
    expect(
      screen.queryByText(/Progress tracking will appear here/),
    ).not.toBeInTheDocument();
    // The guest's own state is the one read — for this word's components only.
    const entry = entries.find((candidate) => candidate.id === 1)!;
    expect(readComponentsSchedulingState).toHaveBeenLastCalledWith(
      expect.anything(),
      null,
      deriveComponentsForEntry(entry).map((component) => component.key),
    );
    // A learner with no history: the first skill is next up, the rest locked.
    const rows = within(card).getAllByTestId("entry-progress-skill");
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual([
      "next",
      "locked",
      "locked",
      "locked",
      "locked",
      "locked",
    ]);
    expect(rows[0]).toHaveTextContent("Next up");
    expect(rows[0]).toHaveTextContent(
      "Meaning recognition (Arabic → English) · māḍī",
    );
    expect(rows[1]).toHaveTextContent(
      "Meaning recall (English → Arabic) · māḍī",
    );
    expect(rows[2]).toHaveTextContent("Bāb identification");
    expect(screen.getByTestId("entry-progress-word-state")).toHaveTextContent(
      "Not started",
    );
    expect(
      screen.queryByText(/Bookmarking will become available/),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("bookmark-toggle")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add to list" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d+\s*%/);
  });

  it("shows each started skill's state, what it unlocked, and skills practised elsewhere", async () => {
    const entry = entries.find((candidate) => candidate.id === 1)!;
    const components = deriveComponentsForEntry(entry);
    const chain = chainForEntry(components);
    const verbType = components.find(
      (c) => c.skillType === "verb_type_identification",
    )!;
    const card = {
      ...reviewCard(newCard(Date.now()), Date.now(), "good"),
      dueAtMs: Date.now() + 5 * 86_400_000,
    };
    readComponentsSchedulingState.mockResolvedValueOnce([
      {
        componentKey: chain[0].key,
        fsrs: card,
        learnerState: "learning",
        qualifiesForNextSkill: true,
      },
      { componentKey: verbType.key, fsrs: card, learnerState: "learning" },
    ]);
    render(<VocabularyDetail idParam="1" />);
    const rows = within(
      await screen.findByTestId("entry-progress-chain"),
    ).getAllByTestId("entry-progress-skill");
    expect(rows[0]).toHaveAttribute("data-status", "started");
    expect(rows[0]).toHaveTextContent("Learning");
    expect(rows[1]).toHaveAttribute("data-status", "next");
    expect(rows[2]).toHaveAttribute("data-status", "locked");
    const also = screen.getByTestId("entry-progress-also");
    expect(also).toHaveTextContent("Verb type identification");
    expect(also).toHaveTextContent("Learning");
    expect(screen.getByTestId("entry-progress-word-state")).toHaveTextContent(
      "Learning",
    );
  });

  it("a failed progress read says so without internals, and retries", async () => {
    readComponentsSchedulingState.mockRejectedValueOnce(
      new Error("DatabaseClosedError: internal detail"),
    );
    render(<VocabularyDetail idParam="1" />);
    const alert = await within(screen.getByTestId("entry-progress")).findByRole(
      "alert",
    );
    expect(alert).toHaveTextContent("Couldn't load your progress");
    expect(alert).not.toHaveTextContent("DatabaseClosedError");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("entry-progress-chain")).toBeInTheDocument(),
    );
  });

  it("never shows the previous word's progress while the next word's read is pending", async () => {
    const entry1 = entries.find((candidate) => candidate.id === 1)!;
    const started1 = chainForEntry(deriveComponentsForEntry(entry1))[0];
    readComponentsSchedulingState.mockResolvedValueOnce([
      {
        componentKey: started1.key,
        fsrs: {
          ...reviewCard(newCard(Date.now()), Date.now(), "good"),
          dueAtMs: Date.now() + 5 * 86_400_000,
        },
        learnerState: "learning",
      },
    ]);
    const { rerender } = render(<VocabularyDetail idParam="1" />);
    await waitFor(() =>
      expect(screen.getByTestId("entry-progress-word-state")).toHaveTextContent(
        "Learning",
      ),
    );

    // A client-side navigation to word 2: the card stays mounted.
    const pending = deferred<StoredComponentState[]>();
    readComponentsSchedulingState.mockReturnValueOnce(pending.promise);
    rerender(<VocabularyDetail idParam="2" />);
    const card = screen.getByTestId("entry-progress");
    expect(
      within(card).getByRole("status", { name: "Loading your progress" }),
    ).toBeInTheDocument();
    expect(
      within(card).queryByTestId("entry-progress-skill"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("entry-progress-word-state"),
    ).not.toBeInTheDocument();

    await act(async () => pending.resolve([]));
    expect(screen.getByTestId("entry-progress-word-state")).toHaveTextContent(
      "Not started",
    );
  });

  it("keeps a working card through a transient refresh failure; persistent failures say so", async () => {
    render(<VocabularyDetail idParam="1" />);
    await screen.findByTestId("entry-progress-chain");

    const before = readComponentsSchedulingState.mock.calls.length;
    readComponentsSchedulingState.mockRejectedValueOnce(new Error("blocked"));
    regainVisibility();
    await act(async () => {});
    // The refresh did run, and failed — the card it found stays.
    expect(readComponentsSchedulingState.mock.calls.length).toBe(before + 1);
    expect(screen.getByTestId("entry-progress-chain")).toBeInTheDocument();
    const card = screen.getByTestId("entry-progress");
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();

    readComponentsSchedulingState.mockRejectedValueOnce(new Error("blocked"));
    regainVisibility();
    await act(async () => {});
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();

    readComponentsSchedulingState.mockRejectedValueOnce(new Error("blocked"));
    regainVisibility();
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Couldn't load your progress",
    );
  });

  it("a burst of visibility changes while a refresh is in flight reads once", async () => {
    render(<VocabularyDetail idParam="1" />);
    await screen.findByTestId("entry-progress-chain");
    const before = readComponentsSchedulingState.mock.calls.length;

    const pending = deferred<StoredComponentState[]>();
    readComponentsSchedulingState.mockReturnValueOnce(pending.promise);
    regainVisibility();
    regainVisibility();
    regainVisibility();
    expect(readComponentsSchedulingState.mock.calls.length).toBe(before + 1);
    await act(async () => pending.resolve([]));
    // Once it settles, the next return refreshes again.
    regainVisibility();
    await act(async () => {});
    expect(readComponentsSchedulingState.mock.calls.length).toBe(before + 2);
  });

  it("renders a not-found state for invalid and absent ids", () => {
    for (const idParam of ["abc", "0", "-4", "1.5", "9999"]) {
      const { unmount } = render(<VocabularyDetail idParam={idParam} />);
      expect(screen.getByText("Entry not found")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /back to library/i }),
      ).toHaveAttribute("href", "/library");
      unmount();
    }
  });

  it("never renders internal metadata field names", () => {
    for (const idParam of ["1", "30", "369"]) {
      const { container, unmount } = render(
        <VocabularyDetail idParam={idParam} />,
      );
      for (const forbidden of INTERNAL_FIELD_NAMES) {
        expect(container.innerHTML, `${forbidden} on ${idParam}`).not.toContain(
          forbidden,
        );
      }
      unmount();
    }
  });
});
