/**
 * Recent-activity trend chart (Phase 12 §13): plain CSS bars over the last
 * `days` local calendar dates ending at `endDate` — no chart dependency.
 * Zero-activity dates keep their bar slot; every bar carries its exact ISO
 * date and value as data attributes; the values are ALSO available to
 * assistive technology through a visually-hidden table (tooltips/hover are
 * never the only access). No animation, so reduced-motion needs no special
 * casing; colours come from theme tokens (dark mode) and the value table —
 * not colour — carries the meaning. Dates render learner-readably ("Jul 19")
 * while `data-date` keeps the exact ISO label for tests.
 */
import { formatInt } from "@/lib/format-number";
import { lastNDates, type DailyActivity } from "@/modules/analytics";

/** Learner-readable label for an ISO date ("2026-07-19" → "Jul 19"). */
function readableDate(isoDate: string): string {
  // The label is parsed as UTC and formatted as UTC, so the rendered day
  // can never shift off its own calendar label in any environment zone.
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function ActivityTrend({
  label,
  endDate,
  days,
  activity,
}: {
  /** Accessible description of the chart (table caption). */
  label: string;
  /** The window's last local date (today in the effective zone). */
  endDate: string;
  /** Window length in days (14 on the dashboard, longer on Progress). */
  days: number;
  /** The derived daily activity rows (any dates outside the window ignored). */
  activity: readonly DailyActivity[];
}) {
  const byDate = new Map(activity.map((row) => [row.localDate, row]));
  const bars = lastNDates(endDate, days).map((date) => ({
    date,
    attempts: byDate.get(date)?.attempts ?? 0,
  }));
  const max = Math.max(1, ...bars.map((bar) => bar.attempts));
  const windowTotal = bars.reduce((sum, bar) => sum + bar.attempts, 0);

  // "Never studied" is judged on the learner's FULL history, not this
  // window: a returning learner whose activity predates the window must
  // never be told "No activity yet" next to their real progress numbers.
  // Derived activity only has rows for dates with real recorded activity,
  // so an empty array IS the genuine all-time zero state (§18).
  if (activity.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="trend-empty">
        No activity yet. Your study days will show up here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div aria-hidden="true">
        <div className="flex h-24 items-end gap-0.5">
          {bars.map((bar) => (
            <div
              key={bar.date}
              data-date={bar.date}
              data-attempts={bar.attempts}
              title={`${readableDate(bar.date)}: ${formatInt(bar.attempts)}`}
              className="bg-muted/60 flex h-full flex-1 flex-col justify-end overflow-hidden rounded-sm"
            >
              <div
                className="bg-primary w-full rounded-sm"
                style={{ height: `${(bar.attempts / max) * 100}%` }}
              />
            </div>
          ))}
        </div>
        <div className="text-muted-foreground mt-1 flex justify-between text-xs">
          <span>{readableDate(bars[0].date)}</span>
          <span>{readableDate(bars[bars.length - 1].date)}</span>
        </div>
        {windowTotal === 0 ? (
          // History exists outside this window: keep every zero bar
          // represented (§13) and say so honestly, window-scoped — never
          // "No activity yet".
          <p
            className="text-muted-foreground mt-2 text-sm"
            data-testid="trend-window-empty"
          >
            No attempts in the last {days} days.
          </p>
        ) : null}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Attempts</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.date}>
              <th scope="row">{readableDate(bar.date)}</th>
              <td>{formatInt(bar.attempts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
