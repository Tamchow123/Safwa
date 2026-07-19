"use client";

/**
 * The learner-editable session defaults (§4.4: questions/session, MC options,
 * new/day, reviews/day) read from the durable Dexie `settings` store. Session
 * screens gate plan building on `loaded` so a session is never built with the
 * documented defaults and then silently rebuilt with the stored ones.
 */
import { useCallback, useEffect, useState } from "react";

import { getSafwaDb } from "@/modules/content/db";
import {
  DEFAULT_SESSION_DEFAULTS,
  persistSessionDefaults,
  readSessionDefaults,
  type SessionDefaults,
} from "@/modules/profile/session-defaults";

export function useSessionDefaults(): {
  defaults: SessionDefaults;
  /** True once the stored value has been read (or defaulted on failure). */
  loaded: boolean;
  /** Persist new defaults durably (guest action) and update local state. */
  update: (next: SessionDefaults) => Promise<void>;
} {
  const [defaults, setDefaults] = useState<SessionDefaults>(
    DEFAULT_SESSION_DEFAULTS,
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await readSessionDefaults(getSafwaDb());
        if (!cancelled) setDefaults(stored);
      } catch {
        // Unreadable settings fall back to the documented defaults.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (next: SessionDefaults) => {
    // Persist first; the state reflects the SANITISED value actually stored.
    const stored = await persistSessionDefaults(
      getSafwaDb(),
      next,
      navigator.storage,
    );
    setDefaults(stored);
  }, []);

  return { defaults, loaded, update };
}
