# modules/analytics

Progress, streak and (Phase 13) weak-area calculations, implementing the exact
formulas in `docs/PRODUCT_REQUIREMENTS.md` §6 over stored event-time local
dates.

## Modules

Pure modules (no React, no Dexie, no DOM, no ambient clocks — every instant
and timezone is injected):

| File          | Responsibility                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `dates.ts`    | ISO date-label validity + calendar arithmetic (never 24-hour-ms maths; DST-safe), instant→local date. |
| `activity.ts` | Daily-activity derivation from raw attempts + scheduling events (the `daily_activity` cache formula). |
| `streaks.ts`  | Study days, current streak (today/yesterday grace), longest streak.                                   |

The browser-only persistence adapter (one consistent snapshot read + atomic
`daily_activity` cache rebuild) and the §6 progress formulas arrive with the
Phase 12 dashboard slices. The authoritative learner truth remains
`study_attempts` + `review_events`; everything here is derived and
rebuildable.
