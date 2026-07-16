"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  DEFAULT_LIBRARY_QUERY,
  parseLibrarySearchParams,
  serializeLibrarySearchParams,
  type LibraryFilterOptions,
  type LibraryQuery,
} from "@/modules/content/query";

/**
 * URL-backed library query state. The URL stays the source of truth for
 * rendering, but a synchronous pending copy is the merge base for updates:
 * router navigation commits asynchronously, so merging a second rapid
 * update (filter click followed immediately by search typing) into the
 * URL-derived query would base it on a stale query and silently drop the
 * first update.
 *
 * Reconciliation mirrors the queued-emissions pattern documented in
 * LibraryToolbar: every issued URL is queued; when the URL catches up to a
 * queued entry the queue is trimmed, and a URL we never issued is an
 * external navigation (back/forward), which clears the pending state so the
 * URL becomes authoritative again.
 */
export function useLibraryQuery(options: LibraryFilterOptions) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const query = useMemo(
    () => parseLibrarySearchParams(new URLSearchParams(searchParams), options),
    [searchParams, options],
  );

  const pendingQuery = useRef<LibraryQuery | null>(null);
  const pendingUrls = useRef<string[]>([]);

  useEffect(() => {
    if (pendingUrls.current.length === 0) return;
    const current = serializeLibrarySearchParams(query).toString();
    const index = pendingUrls.current.indexOf(current);
    if (index >= 0) {
      pendingUrls.current = pendingUrls.current.slice(index + 1);
      if (pendingUrls.current.length === 0) {
        pendingQuery.current = null;
      }
    } else {
      pendingUrls.current = [];
      pendingQuery.current = null;
    }
  }, [query]);

  const navigate = useCallback(
    (next: LibraryQuery, history: "push" | "replace") => {
      pendingQuery.current = next;
      const params = serializeLibrarySearchParams(next);
      pendingUrls.current = [...pendingUrls.current, params.toString()];
      const url = params.size > 0 ? `${pathname}?${params}` : pathname;
      if (history === "replace") {
        router.replace(url, { scroll: false });
      } else {
        router.push(url, { scroll: false });
      }
    },
    [pathname, router],
  );

  const updateQuery = useCallback(
    (partial: Partial<LibraryQuery>, history: "push" | "replace" = "push") => {
      navigate({ ...(pendingQuery.current ?? query), ...partial }, history);
    },
    [navigate, query],
  );

  const resetFilters = useCallback(() => {
    navigate({ ...DEFAULT_LIBRARY_QUERY }, "push");
  }, [navigate]);

  return { query, updateQuery, resetFilters };
}
