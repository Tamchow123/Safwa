/**
 * Accessible exact-ratio progress bars (Phase 12 §17, §19). Presentational
 * only: `ProgressTrack` is the ONE `role="progressbar"` track primitive
 * (ARIA attributes, theme-token colours, and the 100% visual-width cap all
 * live here and nowhere else); `RatioBar` composes it for a finished
 * `ProgressRatio`, rendering the EXACT numerator/denominator text next to
 * the bar. The value text (not colour) carries the meaning; the visual fill
 * is `aria-hidden`. A legitimately empty dimension (denominator 0) renders
 * as unavailable text, never NaN or a fake bar.
 */
import type { ReactNode } from "react";

import { formatInt } from "@/lib/format-number";
import { percentage, type ProgressRatio } from "@/modules/analytics";

/** "X of Y" with grouped digits — the §17 exact-count text. */
export function formatRatio(ratio: ProgressRatio): string {
  return `${formatInt(ratio.numerator)} of ${formatInt(ratio.denominator)}`;
}

/**
 * The one accessible progress-track primitive. `percent` may legitimately
 * exceed 100 (daily targets can be exceeded); the VISUAL fill caps at 100%
 * here, in one place, while `valueText` keeps the real counts.
 */
export function ProgressTrack({
  ariaLabel,
  max,
  now,
  valueText,
  percent,
}: {
  ariaLabel: string;
  max: number;
  now: number;
  valueText: string;
  percent: number;
}) {
  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      aria-valuetext={valueText}
      className="bg-muted h-2 overflow-hidden rounded-full"
    >
      <div
        aria-hidden="true"
        className="bg-primary h-full rounded-full"
        style={{ width: `${Math.min(100, percent)}%` }}
      />
    </div>
  );
}

export function RatioBar({
  label,
  accessibleLabel,
  ratio,
}: {
  /** Visible label (may contain `<ArabicText>` for bāb/verb-type pairs). */
  label: ReactNode;
  /** Plain-string accessible name for the progressbar. */
  accessibleLabel: string;
  ratio: ProgressRatio;
}) {
  const pct = percentage(ratio);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatRatio(ratio)}
          {pct === null ? "" : ` · ${Math.round(pct)}%`}
        </span>
      </div>
      {pct === null ? (
        <p className="text-muted-foreground text-xs">Not available yet.</p>
      ) : (
        <ProgressTrack
          ariaLabel={accessibleLabel}
          max={ratio.denominator}
          now={ratio.numerator}
          valueText={formatRatio(ratio)}
          percent={pct}
        />
      )}
    </div>
  );
}
