/**
 * Pure library query logic: search, filters, sorting and URL <-> state
 * mapping over learner-release entries. Framework-independent and
 * browser-safe — no React, no Dexie, no filesystem. All functions are
 * deterministic and never mutate their inputs.
 *
 * Search uses the approved comparison-only Arabic normalisation
 * (NFC + documented invisibles + trim); display strings are never
 * rewritten, and harakat/shaddah/hamzah distinctions stay meaningful.
 * Only learner-safe fields are indexed — never provenance, review state,
 * generated forms or hidden unresolved roots (which are absent from the
 * learner release by construction).
 */
import type { BabId, VerbTypeId } from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import { normalizeForComparison } from "@/shared/arabic/normalize";

/** The ten learner-release eligibility booleans. */
export const QUIZ_ELIGIBILITY_FIELDS = [
  "madi",
  "mudari",
  "masdar",
  "meaning",
  "ism_fail",
  "amr",
  "nahi",
  "bab",
  "verb_type",
  "root",
] as const;
export type QuizEligibilityField = (typeof QUIZ_ELIGIBILITY_FIELDS)[number];

/** Arabic form fields included in the search index. */
const SEARCHED_ARABIC_FIELDS = [
  "madi",
  "mudari",
  "masdar",
  "ism_fail",
  "amr",
  "nahi",
] as const;

export const LIBRARY_SORTS = [
  "source-order",
  "book-page",
  "meaning",
  "madi",
] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export type EligibilityFilter =
  | "all"
  | "fully-quizzable"
  | "has-not-quizzed"
  | `eligible:${QuizEligibilityField}`;

export type LibraryQuery = {
  search: string;
  bab: BabId | "all";
  verbType: VerbTypeId | "all";
  bookPage: number | "all";
  eligibility: EligibilityFilter;
  sort: LibrarySort;
};

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  search: "",
  bab: "all",
  verbType: "all",
  bookPage: "all",
  eligibility: "all",
  sort: "source-order",
};

/* ------------------------------------------------------------------ */
/* Search index                                                        */
/* ------------------------------------------------------------------ */

export type LibrarySearchIndexEntry = {
  entry: LearnerEntry;
  /** Comparison-normalised Arabic keys (six forms + learner-safe root). */
  arabicKeys: string[];
  /** Lower-cased, whitespace-collapsed meaning. */
  meaningKey: string;
};

export type LibrarySearchIndex = LibrarySearchIndexEntry[];

function englishKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Build the in-memory search index once per loaded release. Indexes only
 * learner-safe searchable fields; display strings are left untouched.
 */
export function createLibrarySearchIndex(
  entries: readonly LearnerEntry[],
): LibrarySearchIndex {
  return entries.map((entry) => {
    const arabicKeys = SEARCHED_ARABIC_FIELDS.map((field) =>
      normalizeForComparison(entry[field]),
    );
    if (entry.root) {
      arabicKeys.push(normalizeForComparison(entry.root));
    }
    return { entry, arabicKeys, meaningKey: englishKey(entry.meaning) };
  });
}

function matchesSearch(
  indexEntry: LibrarySearchIndexEntry,
  search: string,
): boolean {
  const arabicNeedle = normalizeForComparison(search);
  const englishNeedle = englishKey(search);
  if (arabicNeedle.length === 0 && englishNeedle.length === 0) return true;
  return (
    (englishNeedle.length > 0 &&
      indexEntry.meaningKey.includes(englishNeedle)) ||
    (arabicNeedle.length > 0 &&
      indexEntry.arabicKeys.some((key) => key.includes(arabicNeedle)))
  );
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

export function isFullyQuizzable(entry: LearnerEntry): boolean {
  return QUIZ_ELIGIBILITY_FIELDS.every(
    (field) => entry.quiz_eligibility[field],
  );
}

function matchesEligibility(
  entry: LearnerEntry,
  filter: EligibilityFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "fully-quizzable") return isFullyQuizzable(entry);
  if (filter === "has-not-quizzed") return !isFullyQuizzable(entry);
  const field = filter.slice("eligible:".length) as QuizEligibilityField;
  return entry.quiz_eligibility[field] === true;
}

function matchesFilters(entry: LearnerEntry, query: LibraryQuery): boolean {
  if (query.bab !== "all" && entry.bab !== query.bab) return false;
  if (query.verbType !== "all" && entry.verb_type !== query.verbType) {
    return false;
  }
  if (query.bookPage !== "all" && entry.book_page !== query.bookPage) {
    return false;
  }
  return matchesEligibility(entry, query.eligibility);
}

export function filterLibraryEntries(
  index: LibrarySearchIndex,
  query: LibraryQuery,
): LearnerEntry[] {
  return index
    .filter(
      (indexEntry) =>
        matchesFilters(indexEntry.entry, query) &&
        matchesSearch(indexEntry, query.search),
    )
    .map((indexEntry) => indexEntry.entry);
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

const arabicCollator = new Intl.Collator("ar");
const englishCollator = new Intl.Collator("en", { sensitivity: "base" });

/** Non-mutating, stable sort (entry id is always the final tie-breaker). */
export function sortLibraryEntries(
  entries: readonly LearnerEntry[],
  sort: LibrarySort,
): LearnerEntry[] {
  const sorted = [...entries];
  switch (sort) {
    case "source-order":
      sorted.sort((a, b) => a.id - b.id);
      break;
    case "book-page":
      sorted.sort((a, b) => a.book_page - b.book_page || a.id - b.id);
      break;
    case "meaning":
      sorted.sort(
        (a, b) => englishCollator.compare(a.meaning, b.meaning) || a.id - b.id,
      );
      break;
    case "madi":
      sorted.sort(
        (a, b) => arabicCollator.compare(a.madi, b.madi) || a.id - b.id,
      );
      break;
  }
  return sorted;
}

/** Full query: filter + search over the index, then sort. */
export function queryLibraryEntries(
  index: LibrarySearchIndex,
  query: LibraryQuery,
): LearnerEntry[] {
  return sortLibraryEntries(filterLibraryEntries(index, query), query.sort);
}

/* ------------------------------------------------------------------ */
/* Filter options                                                      */
/* ------------------------------------------------------------------ */

export type LibraryFilterOptions = {
  babs: { id: BabId; arabic: string }[];
  verbTypes: { id: VerbTypeId; arabic: string }[];
  bookPages: number[];
};

/**
 * Derive the filter options from the loaded release. Asserts that each bab
 * and verb-type id maps to exactly one dataset-provided Arabic display.
 */
export function deriveLibraryFilterOptions(
  entries: readonly LearnerEntry[],
): LibraryFilterOptions {
  const babs = new Map<BabId, string>();
  const verbTypes = new Map<VerbTypeId, string>();
  const bookPages = new Set<number>();
  for (const entry of entries) {
    const existingBab = babs.get(entry.bab);
    if (existingBab !== undefined && existingBab !== entry.bab_arabic) {
      throw new Error(`bab ${entry.bab} has inconsistent Arabic displays`);
    }
    babs.set(entry.bab, entry.bab_arabic);
    const existingType = verbTypes.get(entry.verb_type);
    if (existingType !== undefined && existingType !== entry.verb_type_arabic) {
      throw new Error(
        `verb type ${entry.verb_type} has inconsistent Arabic displays`,
      );
    }
    verbTypes.set(entry.verb_type, entry.verb_type_arabic);
    bookPages.add(entry.book_page);
  }
  return {
    babs: [...babs.entries()].map(([id, arabic]) => ({ id, arabic })),
    verbTypes: [...verbTypes.entries()].map(([id, arabic]) => ({
      id,
      arabic,
    })),
    bookPages: [...bookPages].sort((a, b) => a - b),
  };
}

/* ------------------------------------------------------------------ */
/* URL state                                                           */
/* ------------------------------------------------------------------ */

const URL_KEYS = {
  search: "q",
  bab: "bab",
  verbType: "type",
  bookPage: "page",
  eligibility: "eligibility",
  sort: "sort",
} as const;

function isEligibilityFilter(value: string): value is EligibilityFilter {
  if (
    value === "all" ||
    value === "fully-quizzable" ||
    value === "has-not-quizzed"
  ) {
    return true;
  }
  return (
    value.startsWith("eligible:") &&
    (QUIZ_ELIGIBILITY_FIELDS as readonly string[]).includes(
      value.slice("eligible:".length),
    )
  );
}

/**
 * Parse URL search params into a LibraryQuery. Unknown or malformed values
 * fall back safely to defaults; option validity against the actual release
 * (e.g. a bab id) is checked against the provided options.
 */
export function parseLibrarySearchParams(
  params: URLSearchParams,
  options: LibraryFilterOptions,
): LibraryQuery {
  const query: LibraryQuery = { ...DEFAULT_LIBRARY_QUERY };

  query.search = params.get(URL_KEYS.search) ?? "";

  const bab = params.get(URL_KEYS.bab);
  if (bab && options.babs.some((option) => option.id === bab)) {
    query.bab = bab as BabId;
  }

  const verbType = params.get(URL_KEYS.verbType);
  if (verbType && options.verbTypes.some((option) => option.id === verbType)) {
    query.verbType = verbType as VerbTypeId;
  }

  const bookPage = params.get(URL_KEYS.bookPage);
  if (bookPage !== null) {
    const parsed = Number(bookPage);
    if (Number.isInteger(parsed) && options.bookPages.includes(parsed)) {
      query.bookPage = parsed;
    }
  }

  const eligibility = params.get(URL_KEYS.eligibility);
  if (eligibility && isEligibilityFilter(eligibility)) {
    query.eligibility = eligibility;
  }

  const sort = params.get(URL_KEYS.sort);
  if (sort && (LIBRARY_SORTS as readonly string[]).includes(sort)) {
    query.sort = sort as LibrarySort;
  }

  return query;
}

/** Serialize a query to URL params, omitting default values. */
export function serializeLibrarySearchParams(
  query: LibraryQuery,
): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search.trim().length > 0) {
    params.set(URL_KEYS.search, query.search);
  }
  if (query.bab !== "all") params.set(URL_KEYS.bab, query.bab);
  if (query.verbType !== "all") params.set(URL_KEYS.verbType, query.verbType);
  if (query.bookPage !== "all") {
    params.set(URL_KEYS.bookPage, String(query.bookPage));
  }
  if (query.eligibility !== "all") {
    params.set(URL_KEYS.eligibility, query.eligibility);
  }
  if (query.sort !== "source-order") params.set(URL_KEYS.sort, query.sort);
  return params;
}

/** Human labels for the eligibility filter options. */
export const ELIGIBILITY_FILTER_LABELS: Record<string, string> = {
  all: "All entries",
  "fully-quizzable": "Fully quizzable",
  "has-not-quizzed": "Has one or more fields not quizzed",
  "eligible:madi": "Eligible for madi",
  "eligible:mudari": "Eligible for mudari",
  "eligible:masdar": "Eligible for masdar",
  "eligible:meaning": "Eligible for meaning",
  "eligible:ism_fail": "Eligible for ism al-fail",
  "eligible:amr": "Eligible for amr",
  "eligible:nahi": "Eligible for nahy",
  "eligible:bab": "Eligible for bab",
  "eligible:verb_type": "Eligible for verb type",
  "eligible:root": "Eligible for root",
};

export const SORT_LABELS: Record<LibrarySort, string> = {
  "source-order": "Source order",
  "book-page": "Book page",
  meaning: "Meaning A–Z",
  madi: "Madi (Arabic)",
};

/** Count of eligibility booleans that are false for an entry. */
export function notQuizzedFieldCount(entry: LearnerEntry): number {
  return QUIZ_ELIGIBILITY_FIELDS.filter(
    (field) => !entry.quiz_eligibility[field],
  ).length;
}
