"use client";

/**
 * The current LOCAL OWNER of private learner-state rows (schema v6, R2-F3): the
 * signed-in account id, or `null` for a guest. Sourced from the AUTH SESSION —
 * never from `sync_state` — because `sync_state.userId` is only set AFTER the
 * first successful pull, so a just-signed-in user who reads or writes before
 * that first pull would otherwise be mis-scoped as a guest (R2-F1). Owner-scoped
 * reads and writes thread this value into the persistence layer so a signed-in
 * account never sees, extends or overwrites a guest's (or another account's)
 * rows that share the same natural key.
 */
import { useCallback, useEffect, useRef } from "react";

import type { LocalOwnerId } from "@/modules/content/db";
import { authClient, useSession } from "@/modules/auth/client";

/**
 * The owner for READ paths. While the session fetch is still in flight this
 * reports the guest owner, which is the correct conservative answer for a read:
 * the view shows un-owned data for one render and re-renders with the account's
 * data the moment the session resolves (every consumer keeps `owner` in its
 * effect deps). Never use this to stamp a WRITE — see {@link useResolveOwner}.
 */
export function useLocalOwner(): LocalOwnerId {
  const { data } = useSession();
  return data?.user?.id ?? null;
}

/**
 * The owner for WRITE paths, resolved at ACTION time (ARCH-002). A write must
 * never be stamped from a session that has not resolved yet: `useSession()`
 * reports `data: undefined` while its fetch is in flight, which is
 * indistinguishable from "signed out", so a signed-in user who clicks a
 * bookmark (or changes a setting) immediately after a page load would otherwise
 * write a guest-owned row — invisible to their own account's owner-scoped reads
 * and never enqueued for sync. That is a narrower re-run of the very R2-F1 bug
 * this module exists to close.
 *
 * The returned callback is stable and cheap: once the session has resolved it
 * answers from the ref; only in the still-pending window does it await
 * `authClient.getSession()` (Better Auth caches that fetch, so this does not add
 * a request per write). Call sites are already async, so adopting it is a
 * one-line change with no change to UI behaviour — the action completes, just
 * with the correct owner.
 */
export function useResolveOwner(): () => Promise<LocalOwnerId> {
  const { data, isPending } = useSession();
  const ownerRef = useRef<LocalOwnerId>(data?.user?.id ?? null);
  const pendingRef = useRef<boolean>(isPending);
  // Mirror into refs in an effect (never during render) so the stable callback
  // below always reads the latest resolved value without being re-created.
  useEffect(() => {
    ownerRef.current = data?.user?.id ?? null;
    pendingRef.current = isPending;
  }, [data, isPending]);

  return useCallback(async () => {
    if (!pendingRef.current) return ownerRef.current;
    try {
      const resolved = await authClient.getSession();
      return resolved.data?.user?.id ?? null;
    } catch {
      // The session could not be resolved (offline / transient failure). Fall
      // back to the last known owner rather than silently claiming guest.
      return ownerRef.current;
    }
  }, []);
}
