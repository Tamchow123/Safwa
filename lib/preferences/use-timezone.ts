"use client";

/**
 * The learner's timezone preference (Phase 12 §10) read from the durable
 * Dexie `settings` store. The preference decides how FUTURE study events
 * stamp their immutable local dates; recorded history is never re-keyed.
 * Consumers gate on `loaded` so the picker never flashes the default while
 * the stored value is still loading.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { getSafwaDb } from "@/modules/content/db";
import {
  DEFAULT_TIMEZONE_PREFERENCE,
  detectBrowserTimezone,
  persistTimezonePreference,
  readTimezonePreference,
  type TimezonePreference,
} from "@/modules/profile/timezone";

export function useTimezonePreference(): {
  preference: TimezonePreference;
  /** True once the stored value has been read (or defaulted on failure). */
  loaded: boolean;
  /** The zone the browser itself reports (shown alongside the picker). */
  detectedTimezone: string;
  /** Persist a new preference durably (guest action) and update local state. */
  update: (next: TimezonePreference) => Promise<void>;
} {
  const [preference, setPreference] = useState<TimezonePreference>(
    DEFAULT_TIMEZONE_PREFERENCE,
  );
  const [loaded, setLoaded] = useState(false);
  // Stable for the mounted component; a browser zone cannot change mid-page.
  const detectedTimezone = useMemo(() => detectBrowserTimezone(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await readTimezonePreference(getSafwaDb());
        if (!cancelled) setPreference(stored);
      } catch {
        // An unreadable setting falls back to browser detection.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (next: TimezonePreference) => {
    // Persist first; the state reflects the SANITISED value actually stored.
    const stored = await persistTimezonePreference(
      getSafwaDb(),
      next,
      navigator.storage,
    );
    setPreference(stored);
  }, []);

  return { preference, loaded, detectedTimezone, update };
}
