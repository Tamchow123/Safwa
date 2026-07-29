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
 *
 * PHASE 18 — THE SESSION HAS THREE ANSWERS, NOT TWO. Both hooks used to read
 * `data?.user?.id ?? null`, which collapses "the server said nobody is signed
 * in" and "the server never answered" into the same `null`. On a cold boot with
 * no network while signed in, Better Auth resolves to
 * `{data: null, error: <non-null>, isPending: false}` — the fetch REJECTED, it
 * is not still in flight — so that expression reported **guest**, and every
 * offline review would have been stamped `ownerKey: "guest"`: a CLAUDE.md hard
 * rule 8 violation, invisible to the account's own owner-scoped reads, and
 * never enqueued for sync. Unreachable before this phase only because an
 * offline cold boot showed the browser's error page; adding the service worker
 * is what makes it reachable (phases-18.md §2).
 *
 * So both hooks now go through {@link classifySessionIdentity}, and the third
 * answer — `unknown` — resolves to the durable last-known owner
 * (`modules/auth/last-known-owner.ts`) instead of to a guest the learner never
 * was. `guest` is the only verdict that resolves to `null`, and it is also the
 * verdict that FORGETS, so the memory can never outlive the account it names.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { LocalOwnerId } from "@/modules/content/db";
import { authClient, useSession } from "@/modules/auth/client";
import {
  forgetLastKnownOwner,
  LAST_KNOWN_OWNER_STORAGE_KEY,
  readLastKnownOwner,
  rememberLastKnownOwner,
} from "@/modules/auth/last-known-owner";
import {
  classifySessionIdentity,
  type SessionIdentity,
} from "@/modules/auth/session-identity";

/**
 * The durable memory, treated as what it is: an EXTERNAL STORE.
 *
 * `useSyncExternalStore` rather than state-set-from-an-effect, for two
 * reasons. Around twenty of this app's routes are prerendered, and the server
 * snapshot below is the framework's own answer to that — it renders `null` on
 * the server and re-reads on the client without a hydration mismatch, where a
 * bare render-time `localStorage` read would produce one. And an effect that
 * called `setState` synchronously is what `react-hooks/set-state-in-effect`
 * rejects (`guest-merge-provider.tsx` hit the same rule and says so).
 *
 * `getSnapshot` re-reads storage per render. That is deliberate: it returns a
 * primitive, so React's `Object.is` check makes it stable and loop-free, and a
 * cached module-level value would be a second source of truth that could drift
 * from the storage it claims to mirror.
 */
function subscribeOwnerMemory(onStoreChange: () => void): () => void {
  // Cross-tab correctness: another tab signing out clears the memory, and a tab
  // sitting on an `unknown` session would otherwise keep rendering the departed
  // account until something else re-rendered it. A `null` key means the whole
  // store was cleared.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === LAST_KNOWN_OWNER_STORAGE_KEY) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * No memory to report: the server snapshot (it has no device storage), and
 * also the client snapshot whenever the answer would be discarded anyway.
 */
function noOwnerMemory(): LocalOwnerId {
  return null;
}

/**
 * The one place a classification turns into a change to the durable memory.
 *
 * Shared by the render-time effect below and by `useResolveOwner`'s late
 * session read, so the rule cannot drift into two versions of itself: a new
 * `SessionIdentity` kind, or a change to what a 401 should do to the memory,
 * has exactly one place to be applied.
 */
function applyOwnerMemory(
  kind: SessionIdentity["kind"],
  accountId: string | null,
): void {
  if (kind === "account" && accountId !== null) {
    rememberLastKnownOwner(accountId);
    return;
  }
  if (kind === "guest") {
    // The server ANSWERED, and the answer was that nobody is signed in. That is
    // the one verdict trustworthy enough to erase a memory on.
    forgetLastKnownOwner();
  }
  // `unknown`: nobody has told us anything, so nothing is written. The fallback
  // to who this device last knew happens in the snapshot read.
}

/** Split a verdict into the two primitives {@link applyOwnerMemory} takes. */
function ownerMemoryInputs(
  identity: SessionIdentity,
): [SessionIdentity["kind"], string | null] {
  return [
    identity.kind,
    identity.kind === "account" ? identity.accountId : null,
  ];
}

/**
 * Keep the durable memory in step with the session, and report what it holds.
 *
 * The WRITES stay in an effect, which is exactly what effects are for —
 * updating an external system from React state. No notification plumbing sits
 * between the two halves, and none is needed: the returned value is only ever
 * consumed under `unknown`, which is the one verdict that writes nothing, so
 * the store cannot change underneath a render that depends on it — except from
 * another tab, which the subscription above covers.
 *
 * Storage is only touched when the answer can actually be used. `useSession()`
 * is read by components that re-render often — `quiz-runner.tsx` re-renders
 * five times a second through a timed question's countdown — and for a
 * signed-in learner the snapshot would be read and thrown away on every one of
 * those renders. `getSnapshot` may differ between renders (unlike `subscribe`,
 * which must be stable), so the resolved cases hand React a constant instead.
 */
function useOwnerMemory(identity: SessionIdentity): LocalOwnerId {
  // Split into primitives so the effect's dependencies are two comparable
  // values rather than a freshly-allocated object, which would re-run it on
  // every render.
  const [kind, accountId] = ownerMemoryInputs(identity);

  useEffect(() => {
    applyOwnerMemory(kind, accountId);
  }, [kind, accountId]);

  return useSyncExternalStore(
    subscribeOwnerMemory,
    kind === "unknown" ? readLastKnownOwner : noOwnerMemory,
    noOwnerMemory,
  );
}

/**
 * The owner for READ paths.
 *
 * A resolved account reports itself; a resolved guest reports the guest owner;
 * and an unresolved session (still pending, or a server that could not be
 * reached) reports the last known owner rather than silently reading a
 * different learner's rows. The guest answer remains the conservative one for a
 * read — it shows un-owned data — but it is now only given when the server
 * actually said so.
 *
 * During the prerender and the first hydration render the memory reads `null`,
 * so an `unknown` session briefly reports the guest owner before settling.
 * That is the same one-render window this hook always had while a session was
 * pending, and it is safe for a read: every consumer keeps `owner` in its
 * effect dependencies and re-runs. Never use this to stamp a WRITE — see
 * {@link useResolveOwner}, which resolves at action time precisely because that
 * window is not safe for one.
 */
export function useLocalOwner(): LocalOwnerId {
  const identity = classifySessionIdentity(useSession());
  const remembered = useOwnerMemory(identity);

  if (identity.kind === "account") return identity.accountId;
  if (identity.kind === "guest") return null;
  return remembered;
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
 * The returned callback is stable and cheap. A resolved session answers from
 * the ref with no I/O. Only a session that is genuinely STILL PENDING awaits
 * `authClient.getSession()` (Better Auth caches that fetch, so this does not
 * add a request per write) — an `unknown` caused by an *error* deliberately
 * does not, because re-asking a server that has already failed would buy a
 * failed round trip per write while offline, which is precisely when writes
 * matter most. That case goes straight to the durable memory.
 *
 * Call sites are already async, so adopting it is a one-line change with no
 * change to UI behaviour — the action completes, just with the correct owner.
 */
export function useResolveOwner(): () => Promise<LocalOwnerId> {
  const session = useSession();
  const identity = classifySessionIdentity(session);
  useOwnerMemory(identity);

  const identityRef = useRef<SessionIdentity>(identity);
  const pendingRef = useRef<boolean>(session.isPending);
  // Mirror into refs in an effect (never during render) so the stable callback
  // below always reads the latest resolved value without being re-created.
  useEffect(() => {
    identityRef.current = identity;
    pendingRef.current = session.isPending;
  }, [identity, session.isPending]);

  return useCallback(async () => {
    const current = identityRef.current;
    if (current.kind === "account") return current.accountId;
    if (current.kind === "guest") return null;

    // `unknown`. If the session is still in flight, one authoritative read can
    // still settle it; classify that answer by the same rules rather than
    // re-deriving them here.
    if (pendingRef.current) {
      try {
        const late = classifySessionIdentity(await authClient.getSession());
        applyOwnerMemory(...ownerMemoryInputs(late));
        if (late.kind === "account") return late.accountId;
        if (late.kind === "guest") return null;
      } catch {
        // The session could not be resolved at all (offline / transient
        // failure). Fall through to the durable memory below — never to guest.
      }
    }

    // Read at action time rather than from the render-time state: this runs in
    // an event handler, where storage is available and the freshest value is
    // free. `null` here means this device has no memory either, which is the
    // honest answer and the same one the pre-Phase-18 code gave.
    return readLastKnownOwner();
  }, []);
}
