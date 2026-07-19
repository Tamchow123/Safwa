"use client";

/**
 * Timezone setting (Phase 12 §10): browser-detected by default, or an explicit
 * IANA zone chosen from the runtime's own zone list. The zone dates FUTURE
 * study activity (streaks, daily targets, activity history); already-recorded
 * events keep their original dates — that immutability is stated in the card
 * copy so the learner knows what changing it does. A native <select> keeps the
 * long zone list keyboard- and mobile-accessible without a custom combobox.
 * No network request is involved; the list comes from Intl.
 *
 * HYDRATION: the detected zone and the zone list come from the RUNTIME's
 * Intl, which differs between the prerendering server and the browser
 * (different host zones, different zone databases). Both are therefore
 * rendered only after mount (the shared `useMounted` gate) — the server and
 * first client render agree on the environment-free markup, then the real
 * values fill in. The regression net for this is the E2E console guard
 * (e2e/fixtures.ts), which fails any spec visiting /settings on the
 * hydration-mismatch error this gate exists to prevent.
 */
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useMounted } from "@/lib/preferences/use-mounted";
import { useTimezonePreference } from "@/lib/preferences/use-timezone";
import { availableTimezones } from "@/modules/profile/timezone";

/** The select value for browser mode. Safe as a sentinel because no real
 * IANA zone id contains a double underscore, so it can never collide with a
 * stored zone. */
const BROWSER_VALUE = "__browser__";

export function TimezoneSettings() {
  const { preference, loaded, detectedTimezone, update } =
    useTimezonePreference();
  const [saving, setSaving] = useState(false);
  const mounted = useMounted();
  const selectId = useId();

  // The BROWSER's zone list, computed once after mount (never during SSR —
  // the server's Intl would render a different list and detected zone).
  const zones = useMemo(() => (mounted ? availableTimezones() : []), [mounted]);

  const selectedValue =
    preference.mode === "iana" ? preference.timezone : BROWSER_VALUE;
  // A stored zone this runtime doesn't list (e.g. chosen elsewhere) must
  // still render as selected rather than silently showing something else.
  const extraZone =
    preference.mode === "iana" && !zones.includes(preference.timezone)
      ? preference.timezone
      : null;

  const save = async (value: string) => {
    setSaving(true);
    try {
      const next =
        value === BROWSER_VALUE
          ? ({ mode: "browser" } as const)
          : ({ mode: "iana", timezone: value } as const);
      await update(next);
      toast("Timezone saved", {
        description:
          next.mode === "browser"
            ? `Following your browser timezone (${detectedTimezone}).`
            : `Future study activity will be dated in ${next.timezone}.`,
      });
    } catch {
      toast("Couldn't save the timezone", { description: "Please try again." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Timezone</h2>
        </CardTitle>
        <CardDescription>
          Sets the calendar day used for streaks, daily targets and activity
          history. Changing it affects future study only — recorded activity
          keeps its original dates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <label htmlFor={selectId} className="text-sm font-medium">
          Timezone
        </label>
        <select
          id={selectId}
          className="border-input bg-background min-h-11 w-full max-w-md rounded-md border px-3 py-2 text-sm"
          disabled={!loaded || saving}
          value={selectedValue}
          data-testid="timezone-select"
          onChange={(event) => void save(event.target.value)}
        >
          <option value={BROWSER_VALUE}>
            Browser timezone{mounted ? ` — ${detectedTimezone}` : ""}
          </option>
          {extraZone !== null && <option value={extraZone}>{extraZone}</option>}
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-xs" role="status">
          {saving
            ? "Saving…"
            : mounted
              ? `Detected browser timezone: ${detectedTimezone}`
              : "Detecting browser timezone…"}
        </p>
      </CardContent>
    </Card>
  );
}
