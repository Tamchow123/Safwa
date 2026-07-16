import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import {
  EXPECTED_BAB_COUNTS,
  EXPECTED_ELIGIBILITY_COUNTS,
} from "@/modules/content/constants";
import {
  createLibrarySearchIndex,
  DEFAULT_LIBRARY_QUERY,
  deriveLibraryFilterOptions,
  filterLibraryEntries,
  isFullyQuizzable,
  parseLibrarySearchParams,
  queryLibraryEntries,
  QUIZ_ELIGIBILITY_FIELDS,
  serializeLibrarySearchParams,
  sortLibraryEntries,
  type LibraryQuery,
} from "@/modules/content/query";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const entries = built.learner.entries;
const index = createLibrarySearchIndex(entries);
const options = deriveLibraryFilterOptions(entries);
const snapshot = JSON.stringify(entries);

function query(partial: Partial<LibraryQuery>): LibraryQuery {
  return { ...DEFAULT_LIBRARY_QUERY, ...partial };
}

function resultIds(partial: Partial<LibraryQuery>): number[] {
  return queryLibraryEntries(index, query(partial)).map((entry) => entry.id);
}

describe("search — English", () => {
  const first = entries[0]; // meaning "to spend" per the dataset

  it("is case-insensitive and matches partially", () => {
    expect(resultIds({ search: first.meaning.toUpperCase() })).toContain(
      first.id,
    );
    expect(resultIds({ search: first.meaning.slice(3, 7) })).toContain(
      first.id,
    );
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(resultIds({ search: `   ${first.meaning}   ` })).toContain(first.id);
    expect(resultIds({ search: first.meaning.replace(" ", "   ") })).toContain(
      first.id,
    );
  });

  it("empty search returns all entries", () => {
    expect(resultIds({ search: "" })).toHaveLength(455);
    expect(resultIds({ search: "   " })).toHaveLength(455);
  });
});

describe("search — Arabic", () => {
  const first = entries[0];

  it.each(["madi", "mudari", "masdar", "ism_fail", "amr", "nahi"] as const)(
    "finds entries by their %s form",
    (field) => {
      expect(resultIds({ search: first[field] })).toContain(first.id);
    },
  );

  it("matches NFC-equivalent text", () => {
    // Select an entry whose madi actually changes under NFD (contains a
    // precomposed character such as alef-with-hamza), so the test is real.
    const nfcSensitive = entries.find(
      (entry) => entry.madi.normalize("NFD") !== entry.madi,
    );
    expect(nfcSensitive).toBeDefined();
    const decomposed = nfcSensitive!.madi.normalize("NFD");
    expect(resultIds({ search: decomposed })).toContain(nfcSensitive!.id);
  });

  it("ignores approved invisible characters in the search input", () => {
    const zwsp = String.fromCodePoint(0x200b);
    const bom = String.fromCodePoint(0xfeff);
    const noisy = `${zwsp}${first.madi}${bom}`;
    expect(resultIds({ search: noisy })).toContain(first.id);
  });

  it("finds a learner-safe root when present", () => {
    expect(first.root).toBeDefined();
    expect(resultIds({ search: first.root! })).toContain(first.id);
  });

  it("does not index hidden unresolved roots (369, 372)", () => {
    for (const id of [369, 372]) {
      const indexEntry = index.find((candidate) => candidate.entry.id === id)!;
      // Six searched form fields only — no root key was added.
      expect(indexEntry.arabicKeys).toHaveLength(6);
    }
    const withRoot = index.find((candidate) => candidate.entry.id === 1)!;
    expect(withRoot.arabicKeys).toHaveLength(7);
  });

  it("does not index internal metadata", () => {
    const serialized = JSON.stringify(index);
    for (const forbidden of [
      "root_provenance",
      "data_quality",
      "needs_review",
      "additional_forms",
      "mazid",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(resultIds({ search: "internally_validated" })).toHaveLength(0);
  });

  it("querying never mutates display strings", () => {
    resultIds({ search: entries[0].madi.normalize("NFD") });
    resultIds({ search: "test" });
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});

describe("filters", () => {
  it("each bab filter returns exactly that bab", () => {
    for (const bab of options.babs) {
      const results = filterLibraryEntries(index, query({ bab: bab.id }));
      expect(results.length).toBe(
        EXPECTED_BAB_COUNTS[bab.id as keyof typeof EXPECTED_BAB_COUNTS],
      );
      expect(results.every((entry) => entry.bab === bab.id)).toBe(true);
    }
  });

  it("each verb-type filter returns only that type", () => {
    for (const verbType of options.verbTypes) {
      const results = filterLibraryEntries(
        index,
        query({ verbType: verbType.id }),
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((entry) => entry.verb_type === verbType.id)).toBe(
        true,
      );
    }
  });

  it("book-page filtering is exact", () => {
    const page = options.bookPages[0];
    const results = filterLibraryEntries(index, query({ bookPage: page }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => entry.book_page === page)).toBe(true);
  });

  it("per-field eligibility filters use the correct booleans", () => {
    for (const field of QUIZ_ELIGIBILITY_FIELDS) {
      const results = filterLibraryEntries(
        index,
        query({ eligibility: `eligible:${field}` }),
      );
      expect(results.length, field).toBe(EXPECTED_ELIGIBILITY_COUNTS[field]);
      expect(
        results.every((entry) => entry.quiz_eligibility[field] === true),
      ).toBe(true);
    }
  });

  it("fully-quizzable and has-not-quizzed are complementary", () => {
    const fully = filterLibraryEntries(
      index,
      query({ eligibility: "fully-quizzable" }),
    );
    const notFully = filterLibraryEntries(
      index,
      query({ eligibility: "has-not-quizzed" }),
    );
    expect(fully.length + notFully.length).toBe(455);
    expect(fully.every(isFullyQuizzable)).toBe(true);
    expect(notFully.some((entry) => entry.id === 369)).toBe(true);
    expect(notFully.some((entry) => entry.id === 372)).toBe(true);
  });

  it("combined filters use AND semantics", () => {
    const results = filterLibraryEntries(
      index,
      query({ bab: "nasara", eligibility: "eligible:masdar" }),
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(EXPECTED_BAB_COUNTS.nasara);
    expect(
      results.every(
        (entry) =>
          entry.bab === "nasara" && entry.quiz_eligibility.masdar === true,
      ),
    ).toBe(true);
  });
});

describe("sorting", () => {
  it("source order is id ascending", () => {
    const ids = sortLibraryEntries(entries, "source-order").map((e) => e.id);
    expect(ids[0]).toBe(1);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("book-page sort is stable with id tie-break", () => {
    const sorted = sortLibraryEntries(entries, "book-page");
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      expect(
        prev.book_page < next.book_page ||
          (prev.book_page === next.book_page && prev.id < next.id),
      ).toBe(true);
    }
  });

  it("meaning sort is case-insensitive with id tie-break", () => {
    const collator = new Intl.Collator("en", { sensitivity: "base" });
    const sorted = sortLibraryEntries(entries, "meaning");
    for (let i = 1; i < sorted.length; i += 1) {
      const compared = collator.compare(
        sorted[i - 1].meaning,
        sorted[i].meaning,
      );
      expect(
        compared < 0 || (compared === 0 && sorted[i - 1].id < sorted[i].id),
      ).toBe(true);
    }
  });

  it("madi sort uses the Arabic collator with id tie-break", () => {
    const collator = new Intl.Collator("ar");
    const sorted = sortLibraryEntries(entries, "madi");
    for (let i = 1; i < sorted.length; i += 1) {
      const compared = collator.compare(sorted[i - 1].madi, sorted[i].madi);
      expect(
        compared < 0 || (compared === 0 && sorted[i - 1].id < sorted[i].id),
      ).toBe(true);
    }
  });

  it("sorting never mutates the input array", () => {
    const before = entries.map((entry) => entry.id).join(",");
    sortLibraryEntries(entries, "meaning");
    sortLibraryEntries(entries, "madi");
    expect(entries.map((entry) => entry.id).join(",")).toBe(before);
  });
});

describe("filter options", () => {
  it("derives six babs, all verb types and sorted unique pages", () => {
    expect(options.babs).toHaveLength(6);
    expect(options.verbTypes.length).toBe(13);
    expect(options.bookPages).toEqual(
      [...options.bookPages].sort((a, b) => a - b),
    );
    expect(new Set(options.bookPages).size).toBe(options.bookPages.length);
  });

  it("one bab id maps to one Arabic pair", () => {
    for (const bab of options.babs) {
      const displays = new Set(
        entries
          .filter((entry) => entry.bab === bab.id)
          .map((entry) => entry.bab_arabic),
      );
      expect(displays.size).toBe(1);
      expect([...displays][0]).toBe(bab.arabic);
    }
  });
});

describe("URL state", () => {
  it("round-trips a fully specified query", () => {
    const original = query({
      search: "spend",
      bab: "nasara",
      verbType: "sahih",
      bookPage: options.bookPages[0],
      eligibility: "eligible:masdar",
      sort: "meaning",
    });
    const parsed = parseLibrarySearchParams(
      serializeLibrarySearchParams(original),
      options,
    );
    expect(parsed).toEqual(original);
  });

  it("omits default values from the URL", () => {
    expect(serializeLibrarySearchParams(DEFAULT_LIBRARY_QUERY).toString()).toBe(
      "",
    );
  });

  it("unknown or malformed values fall back safely", () => {
    const parsed = parseLibrarySearchParams(
      new URLSearchParams(
        "bab=nope&type=fake&page=abc&eligibility=eligible:hacked&sort=random",
      ),
      options,
    );
    expect(parsed).toEqual(DEFAULT_LIBRARY_QUERY);
  });

  it("rejects a page number not present in the release", () => {
    const parsed = parseLibrarySearchParams(
      new URLSearchParams("page=99999"),
      options,
    );
    expect(parsed.bookPage).toBe("all");
  });
});

describe("protected content", () => {
  it("default query returns all 455 entries", () => {
    expect(queryLibraryEntries(index, DEFAULT_LIBRARY_QUERY)).toHaveLength(455);
  });

  it("duplicate-madi entries stay separate and both searchable", () => {
    for (const [a, b] of [
      [262, 275],
      [297, 303],
      [409, 413],
    ]) {
      const entryA = entries.find((entry) => entry.id === a)!;
      const results = resultIds({ search: entryA.madi });
      expect(results).toContain(a);
      expect(results).toContain(b);
    }
  });

  it("entries 369 and 372 remain present", () => {
    const ids = resultIds({});
    expect(ids).toContain(369);
    expect(ids).toContain(372);
  });
});
