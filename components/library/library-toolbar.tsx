"use client";

import { useState } from "react";

import { ArabicText } from "@/components/arabic-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ELIGIBILITY_FILTER_LABELS,
  LIBRARY_SORTS,
  QUIZ_ELIGIBILITY_FIELDS,
  SORT_LABELS,
  type LibraryFilterOptions,
  type LibraryQuery,
} from "@/modules/content/query";

const ELIGIBILITY_VALUES = [
  "all",
  "fully-quizzable",
  "has-not-quizzed",
  ...QUIZ_ELIGIBILITY_FIELDS.map((field) => `eligible:${field}`),
];

/**
 * Search, filter and sort controls. Every control has a visible label;
 * state changes are reported to the parent, which owns the URL.
 */
export function LibraryToolbar({
  query,
  options,
  onChange,
  onReset,
}: {
  query: LibraryQuery;
  options: LibraryFilterOptions;
  onChange: (
    partial: Partial<LibraryQuery>,
    history?: "push" | "replace",
  ) => void;
  onReset: () => void;
}) {
  // The input keeps local state so fast typing never loses keystrokes while
  // the URL catches up. Emitted values are queued; a URL search value found
  // in the queue is just our own (possibly stale) emission and is ignored,
  // while a value we never emitted is an external change (reset, back/
  // forward) and syncs into the input. This is the documented render-time
  // state-adjustment pattern (no effects, no refs during render).
  const [searchInput, setSearchInput] = useState(query.search);
  const [pendingEmits, setPendingEmits] = useState<string[]>([]);
  const [lastSeenQuerySearch, setLastSeenQuerySearch] = useState(query.search);
  if (query.search !== lastSeenQuerySearch) {
    setLastSeenQuerySearch(query.search);
    const pendingIndex = pendingEmits.indexOf(query.search);
    if (pendingIndex >= 0) {
      setPendingEmits(pendingEmits.slice(pendingIndex + 1));
    } else if (pendingEmits.length === 0) {
      setSearchInput(query.search);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="library-search">Search vocabulary</Label>
        <Input
          id="library-search"
          type="search"
          value={searchInput}
          placeholder="Search Arabic forms or English meanings"
          autoComplete="off"
          onChange={(event) => {
            const value = event.target.value;
            setSearchInput(value);
            setPendingEmits((previous) => [...previous, value]);
            onChange({ search: value }, "replace");
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="space-y-1.5">
          <Label htmlFor="filter-bab">Bab</Label>
          <Select
            value={query.bab}
            onValueChange={(value) =>
              onChange({ bab: value as LibraryQuery["bab"] })
            }
          >
            <SelectTrigger id="filter-bab" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All babs</SelectItem>
              {options.babs.map((bab) => (
                <SelectItem key={bab.id} value={bab.id}>
                  <span className="flex items-center gap-2">
                    {bab.id}
                    <ArabicText className="text-xs">{bab.arabic}</ArabicText>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-verb-type">Verb type</Label>
          <Select
            value={query.verbType}
            onValueChange={(value) =>
              onChange({ verbType: value as LibraryQuery["verbType"] })
            }
          >
            <SelectTrigger id="filter-verb-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All verb types</SelectItem>
              {options.verbTypes.map((verbType) => (
                <SelectItem key={verbType.id} value={verbType.id}>
                  {verbType.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-book-page">Book page</Label>
          <Select
            value={String(query.bookPage)}
            onValueChange={(value) =>
              onChange({
                bookPage: value === "all" ? "all" : Number(value),
              })
            }
          >
            <SelectTrigger id="filter-book-page" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All pages</SelectItem>
              {options.bookPages.map((page) => (
                <SelectItem key={page} value={String(page)}>
                  Page {page}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-eligibility">Quiz eligibility</Label>
          <Select
            value={query.eligibility}
            onValueChange={(value) =>
              onChange({ eligibility: value as LibraryQuery["eligibility"] })
            }
          >
            <SelectTrigger id="filter-eligibility" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ELIGIBILITY_VALUES.map((value) => (
                <SelectItem key={value} value={value}>
                  {ELIGIBILITY_FILTER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="library-sort">Sort by</Label>
          <Select
            value={query.sort}
            onValueChange={(value) =>
              onChange({ sort: value as LibraryQuery["sort"] })
            }
          >
            <SelectTrigger id="library-sort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIBRARY_SORTS.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {SORT_LABELS[sort]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-9"
        onClick={onReset}
      >
        Reset filters
      </Button>
    </div>
  );
}
