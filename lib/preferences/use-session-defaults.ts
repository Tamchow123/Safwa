"use client";

/**
 * The learner-editable session defaults (§4.4: questions/session, MC options,
 * new/day, reviews/day) read from the durable Dexie `settings` store. Session
 * screens gate plan building on `loaded` so a session is never built with the
 * documented defaults and then silently rebuilt with the stored ones.
 */
import { useCallback, useEffect, useState } from "react";

import {
  useLocalOwner,
  useResolveOwner,
} from "@/components/sync/use-local-owner";
import { DB_READ_TIMEOUT_MS, withTimeout } from "@/lib/with-timeout";
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
  // Owner-scoped (R2-F3): a signed-in account reads/writes its own defaults,
  // never a pre-login guest's, from the account-authoritative Auth session.
  const owner = useLocalOwner();
  const resolveOwner = useResolveOwner();
  const [defaults, setDefaults] = useState<SessionDefaults>(
    DEFAULT_SESSION_DEFAULTS,
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Bounded: a read that never settles (e.g. a blocked schema-upgrade
        // open) must not gate a page on `loaded` forever — it falls back to
        // the documented defaults like any other read failure.
        const stored = await withTimeout(
          readSessionDefaults(getSafwaDb(), owner),
          DB_READ_TIMEOUT_MS,
          "session-defaults read timed out",
        );
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
  }, [owner]);

  const update = useCallback(
    async (next: SessionDefaults) => {
      // Persist first; the state reflects the SANITISED value actually stored.
      // ARCH-002: resolve the owner at action time (see useResolveOwner).
      const stored = await persistSessionDefaults(
        getSafwaDb(),
        next,
        navigator.storage,
        {},
        await resolveOwner(),
      );
      setDefaults(stored);
    },
    [resolveOwner],
  );

  return { defaults, loaded, update };
}
