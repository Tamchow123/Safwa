"use client";

/**
 * The Weak Areas dimension selector (Phase 13 §15 "Dimension selector/
 * tabs"). Implemented as a row of toggle buttons with `aria-pressed`,
 * matching the existing config-selector convention used throughout
 * `components/study/*` (flashcard/mc-quiz/custom session direction pickers)
 * rather than introducing a new ARIA tabs primitive with no precedent in
 * this codebase and its own non-trivial keyboard-navigation contract.
 */
import { Button } from "@/components/ui/button";
import {
  WEAKNESS_DIMENSIONS,
  type WeaknessDimension,
} from "@/modules/analytics/weakness-groups";

export type WeakAreasTab = "overview" | WeaknessDimension;

export const WEAK_AREAS_TABS: readonly WeakAreasTab[] = [
  "overview",
  ...WEAKNESS_DIMENSIONS,
];

/** The six dimension labels, shared with the per-dimension list section
 * title in `weak-areas-page-client.tsx` so the button and its section
 * heading can never say two different things for the same dimension. */
export const WEAKNESS_DIMENSION_LABELS: Record<WeaknessDimension, string> = {
  bab: "Bāb",
  verb_type: "Verb type",
  source_form: "Form",
  direction: "Direction",
  skill: "Skill",
  state: "State",
};

const TAB_LABELS: Record<WeakAreasTab, string> = {
  overview: "Overview",
  ...WEAKNESS_DIMENSION_LABELS,
};

export function WeaknessDimensionTabs({
  selected,
  onSelect,
}: {
  selected: WeakAreasTab;
  onSelect: (tab: WeakAreasTab) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter weak areas by dimension"
      className="flex flex-wrap gap-2"
    >
      {WEAK_AREAS_TABS.map((tab) => (
        <Button
          key={tab}
          type="button"
          variant={selected === tab ? "default" : "outline"}
          aria-pressed={selected === tab}
          className="min-h-11"
          onClick={() => onSelect(tab)}
        >
          {TAB_LABELS[tab]}
        </Button>
      ))}
    </div>
  );
}
