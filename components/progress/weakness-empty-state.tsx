"use client";

/**
 * The two Weak Areas empty states (Phase 13 §15), never rendered as an
 * error: "no study evidence yet" (a brand-new learner, or content that has
 * never been attempted) versus "evidence exists but nothing currently
 * qualifies as weak" (shown per-dimension too, whenever that view's own
 * group list is empty even though other areas have evidence).
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";

export type WeaknessEmptyVariant = "no-evidence" | "no-weakness";

const COPY: Record<WeaknessEmptyVariant, string> = {
  "no-evidence":
    "Study a few items to discover which areas need more practice.",
  "no-weakness": "No clear weak areas right now.",
};

export function WeaknessEmptyState({
  variant,
}: {
  variant: WeaknessEmptyVariant;
}) {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">{COPY[variant]}</p>
      {variant === "no-evidence" ? (
        <Button asChild className="min-h-11">
          <Link href="/study">Start studying</Link>
        </Button>
      ) : null}
    </div>
  );
}
