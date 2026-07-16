import { readFileSync } from "node:fs";

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
const routerReplace = vi.fn();
let params = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  usePathname: () => "/library",
  useSearchParams: () => params,
}));

import { useLibraryQuery } from "@/components/library/use-library-query";
import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import { deriveLibraryFilterOptions } from "@/modules/content/query";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));
const options = deriveLibraryFilterOptions(built.learner.entries);
const babA = options.babs[0].id;
const babB = options.babs[1].id;

function lastUrl(spy: ReturnType<typeof vi.fn>): URLSearchParams {
  const url = spy.mock.calls.at(-1)![0] as string;
  return new URL(url, "http://localhost").searchParams;
}

describe("useLibraryQuery", () => {
  beforeEach(() => {
    routerPush.mockClear();
    routerReplace.mockClear();
    params = new URLSearchParams();
  });

  it("merges rapid updates across controls before the URL commits", () => {
    const { result } = renderHook(() => useLibraryQuery(options));

    // Filter click immediately followed by search typing, with NO router
    // commit in between (searchParams never changes). The second update
    // must build on the first, not on the stale URL-derived query.
    act(() => {
      result.current.updateQuery({ bab: babA });
      result.current.updateQuery({ search: "x" }, "replace");
    });

    expect(lastUrl(routerPush).get("bab")).toBe(babA);
    const merged = lastUrl(routerReplace);
    expect(merged.get("bab")).toBe(babA);
    expect(merged.get("q")).toBe("x");
  });

  it("treats the URL as authoritative again once it catches up", () => {
    const { result, rerender } = renderHook(() => useLibraryQuery(options));

    act(() => {
      result.current.updateQuery({ bab: babA });
      result.current.updateQuery({ search: "x" }, "replace");
    });
    // The router commits the final URL.
    params = new URLSearchParams(`bab=${babA}&q=x`);
    rerender();

    act(() => {
      result.current.updateQuery({ search: "" }, "replace");
    });
    const cleared = lastUrl(routerReplace);
    expect(cleared.get("bab")).toBe(babA);
    expect(cleared.get("q")).toBeNull();
  });

  it("adopts an external navigation (back/forward) over stale pending state", () => {
    const { result, rerender } = renderHook(() => useLibraryQuery(options));

    act(() => {
      result.current.updateQuery({ bab: babA });
    });
    // Before our navigation commits, the user lands on a different URL.
    params = new URLSearchParams(`bab=${babB}`);
    rerender();

    expect(result.current.query.bab).toBe(babB);
    act(() => {
      result.current.updateQuery({ search: "y" }, "replace");
    });
    const merged = lastUrl(routerReplace);
    expect(merged.get("bab")).toBe(babB);
    expect(merged.get("q")).toBe("y");
  });

  it("reset clears pending state so later updates start from defaults", () => {
    const { result } = renderHook(() => useLibraryQuery(options));

    act(() => {
      result.current.updateQuery({ bab: babA });
      result.current.resetFilters();
      result.current.updateQuery({ search: "z" }, "replace");
    });

    expect(routerPush).toHaveBeenLastCalledWith("/library", { scroll: false });
    const merged = lastUrl(routerReplace);
    expect(merged.get("bab")).toBeNull();
    expect(merged.get("q")).toBe("z");
  });
});
