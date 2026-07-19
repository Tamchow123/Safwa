"use client";

/**
 * One weak-area group row (Phase 13 §15, §16): a learner-facing label (never
 * a raw component key — see §10 "do not expose the internal component key"),
 * a High/Medium/Lower priority label instead of the raw score, exact recent-
 * accuracy/lapse/last-practised context, and the drill action. Supportive
 * wording throughout (§16): "Practice priority", never "Bad at"/"Worst".
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatInt } from "@/lib/format-number";
import { WEAK_THRESHOLD } from "@/modules/analytics/weakness";
import type { WeaknessGroup } from "@/modules/analytics/weakness-groups";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Above this raw score a group is called "High" priority (§16 labels). */
const HIGH_PRIORITY_SCORE = 0.5;

type PriorityTier = "High" | "Medium" | "Lower";

/** Reuses the documented v2 qualification threshold as the Medium/Lower
 * boundary, rather than inventing a second unrelated cut-off. */
function priorityTier(score: number): PriorityTier {
  if (score >= HIGH_PRIORITY_SCORE) return "High";
  if (score >= WEAK_THRESHOLD) return "Medium";
  return "Lower";
}

const PRIORITY_BADGE_VARIANT: Record<
  PriorityTier,
  "default" | "secondary" | "outline"
> = {
  High: "default",
  Medium: "secondary",
  Lower: "outline",
};

function formatLastPractised(
  lastAttemptAtMs: number | null,
  nowMs: number,
): string {
  if (lastAttemptAtMs === null) return "Not yet practised";
  const days = Math.floor(Math.max(0, nowMs - lastAttemptAtMs) / DAY_MS);
  if (days === 0) return "Practised today";
  if (days === 1) return "Practised yesterday";
  return `Practised ${formatInt(days)} days ago`;
}

export function WeaknessGroupCard({
  label,
  accessibleLabel,
  group,
  drillHref,
  nowMs,
}: {
  /** Visible label (may contain `<ArabicText>` for bāb/verb-type pairs). */
  label: ReactNode;
  accessibleLabel: string;
  group: WeaknessGroup;
  drillHref: string;
  nowMs: number;
}) {
  const tier = priorityTier(group.weaknessScore);
  return (
    <article
      aria-label={accessibleLabel}
      className="bg-card space-y-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">{label}</div>
        <Badge variant={PRIORITY_BADGE_VARIANT[tier]} className="font-normal">
          {tier} priority
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Recent accuracy</dt>
          <dd className="tabular-nums">
            {group.firstAttemptAccuracy === null
              ? "Not enough attempts yet"
              : `${Math.round(group.firstAttemptAccuracy * 100)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Review lapses</dt>
          <dd className="tabular-nums">{formatInt(group.lapseCount)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last practised</dt>
          <dd>{formatLastPractised(group.lastAttemptAtMs, nowMs)}</dd>
        </div>
      </dl>
      <Button asChild variant="outline" className="min-h-11">
        <Link href={drillHref}>Review this area</Link>
      </Button>
    </article>
  );
}
