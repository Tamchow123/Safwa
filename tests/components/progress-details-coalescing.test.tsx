/**
 * Regression coverage for REL-001 (Phase 13 phase-review): `ProgressDetails`
 * mounts `useAnalyticsSnapshot()` and `useWeaknessSnapshot()` together in the
 * same render pass specifically so their internal `useActiveContent()` calls
 * land in the same task and genuinely coalesce into one `loadActiveContent()`
 * call and one `deriveAllComponents()` pass. Unlike
 * `tests/components/progress-page.test.tsx` (which mocks `useActiveContent`
 * itself, bypassing the coalescing entirely) and
 * `tests/components/use-active-content.test.tsx` (which proves the isolated
 * mechanism works via two adjacent `renderHook()` calls), this test renders
 * the REAL `ProgressDetails` component tree against a mocked
 * `loadActiveContent`/`deriveAllComponents` to prove the composition — not
 * just the mechanism — actually coalesces.
 */
import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProgressDetails } from "@/components/progress/progress-details";
import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import type { LoadContentResult } from "@/modules/content/load";
import type {
  AnalyticsPersistenceSnapshot,
  AnalyticsRawRead,
} from "@/modules/analytics/persistence";
import * as studyEngineComponents from "@/modules/study-engine/components";

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));

const loadActiveContent = vi.fn<() => Promise<LoadContentResult>>();
vi.mock("@/modules/content/load", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/load")>();
  return { ...original, loadActiveContent: () => loadActiveContent() };
});

vi.mock("@/modules/content/db", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/content/db")>();
  return { ...original, getSafwaDb: () => ({}) as never };
});

vi.mock("@/modules/profile/timezone", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/timezone")>();
  return {
    ...original,
    readEffectiveClock: vi.fn(async () => ({
      now: () => Date.UTC(2026, 6, 19, 12, 0, 0),
      timezone: "UTC",
      timezoneSource: "browser_detected" as const,
    })),
  };
});

const readAnalyticsSnapshot =
  vi.fn<(db: unknown, now: number) => Promise<AnalyticsPersistenceSnapshot>>();
const readAnalyticsRawSnapshot =
  vi.fn<(db: unknown) => Promise<AnalyticsRawRead>>();
vi.mock("@/modules/analytics/persistence", () => ({
  readAnalyticsSnapshot: (db: unknown, now: number) =>
    readAnalyticsSnapshot(db, now),
  readAnalyticsRawSnapshot: (db: unknown) => readAnalyticsRawSnapshot(db),
  rebuildDailyActivity: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProgressDetails — content load and derivation coalescing (REL-001)", () => {
  it("loads content and derives components exactly once for the whole page", async () => {
    loadActiveContent.mockResolvedValue({
      ok: true,
      source: "cache",
      releaseId: built.releaseId,
      contentVersion: built.learner.content_version,
      questionGeneratorVersion: built.learner.question_generator_version,
      entryCount: built.learner.entries.length,
      entries: built.learner.entries,
    });
    readAnalyticsSnapshot.mockResolvedValue({
      components: [],
      attempts: [],
      events: [],
      dailyActivity: [],
    });
    readAnalyticsRawSnapshot.mockResolvedValue({
      components: [],
      attempts: [],
      events: [],
    });
    const deriveSpy = vi.spyOn(studyEngineComponents, "deriveAllComponents");

    render(<ProgressDetails />);

    await screen.findByText("Weak areas");
    await screen.findByText("Started");

    expect(loadActiveContent).toHaveBeenCalledTimes(1);
    expect(deriveSpy).toHaveBeenCalledTimes(1);
  });
});
