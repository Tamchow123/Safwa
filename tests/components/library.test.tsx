import { readFileSync } from "node:fs";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { ActiveContentState } from "@/components/content/use-active-content";

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
    expect(container.textContent).toMatch(/field\(s\) not quizzed/);
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
  it("badge is textual", () => {
    const { rerender } = render(<EligibilityBadge eligible />);
    expect(screen.getByText("Quizzed")).toBeInTheDocument();
    rerender(<EligibilityBadge eligible={false} />);
    expect(screen.getByText("Not quizzed")).toBeInTheDocument();
  });

  it("field renders Arabic values through ArabicText", () => {
    const { container } = render(
      <dl>
        <VocabularyField label="Madi" value={entries[0].madi} arabic eligible />
      </dl>,
    );
    const arabic = container.querySelector('[lang="ar"][dir="rtl"]');
    expect(arabic?.textContent).toContain(entries[0].madi);
    expect(screen.getByText("Quizzed")).toBeInTheDocument();
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
    expect(screen.getByText("Not quizzed")).toBeInTheDocument();
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
    // Entry 30: masdar is quiz-ineligible while other fields stay quizzed.
    render(<VocabularyDetail idParam="30" />);
    const masdarField = screen.getByTestId("detail-masdar");
    expect(within(masdarField).getByText("Not quizzed")).toBeInTheDocument();
    const mudariField = screen.getByTestId("detail-mudari");
    expect(within(mudariField).getByText("Quizzed")).toBeInTheDocument();
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
    expect(within(rootField).getByText("Not quizzed")).toBeInTheDocument();
    expect(rootField.querySelector('[lang="ar"]')).toBeNull();
    const verbTypeField = screen.getByTestId("detail-verb-type");
    expect(within(verbTypeField).getByText("Not quizzed")).toBeInTheDocument();
  });

  it("shows the progress placeholder without fake data, and real collection controls instead of the retired bookmark placeholder", () => {
    const { container } = render(<VocabularyDetail idParam="1" />);
    expect(
      screen.getByText(/Progress tracking will appear here/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Bookmarking will become available/),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("bookmark-toggle")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add to list" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d+\s*%/);
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
