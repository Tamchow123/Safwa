"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useResolveOwner } from "@/components/sync/use-local-owner";
import {
  applyArabicFontScale,
  ARABIC_FONT_SCALE_STORAGE_KEY,
  DEFAULT_ARABIC_FONT_SCALE,
  readArabicFontScale,
  writeArabicFontScale,
  type ArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";
import type { LocalOwnerId } from "@/modules/content/db";
import { getSafwaDb } from "@/modules/content/db";
import {
  persistArabicFontScale,
  syncArabicFontScale,
} from "@/modules/profile/settings";

/*
 * Storage model (Phase 5): Dexie is the durable authority for the setting;
 * localStorage is a synchronous mirror kept only so hydration and first
 * paint can read the value without an async gap. Writes go to both;
 * reconcileArabicFontScaleFromDb aligns the mirror from Dexie at app start
 * (and migrates a pre-Phase-5 localStorage-only value into Dexie).
 *
 * The React snapshot is an in-memory value seeded from the mirror, updated
 * by user writes, Dexie reconciliation and cross-tab `storage` events. It
 * deliberately does NOT read localStorage on every snapshot: if the mirror
 * write fails (quota-blocked Web Storage), the in-memory value still
 * reflects the user's choice, keeping the controls, the applied CSS scale
 * and the durable Dexie copy coherent for the session. The server snapshot
 * is the default, so SSR output is hydration-safe and the stored value
 * applies right after hydration.
 *
 * Cross-tab `storage` events are adopted by an app-lifetime watcher
 * (watchArabicFontScaleMirror, mounted by ArabicFontScaleInitializer), NOT
 * by per-subscriber listeners: a cross-tab change arriving while no
 * component subscribes (e.g. Settings unmounted) must still refresh the
 * cached snapshot, or the next subscriber would read a stale value until a
 * full reload.
 */
const listeners = new Set<() => void>();

/** In-memory client truth; null until first read seeds it from the mirror. */
let clientScale: ArabicFontScale | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Adopt cross-tab mirror changes for as long as the caller (the app shell's
 * initializer) lives, updating the cached snapshot, the applied CSS scale
 * and every subscribed component. The `storage` event only fires for writes
 * from OTHER tabs, so re-seeding from the mirror here can never clobber a
 * same-tab choice whose own mirror write failed — but events for unrelated
 * keys are ignored for exactly that reason: after a failed same-tab mirror
 * write the mirror is STALER than the in-memory value, and only an actual
 * cross-tab write (or clear) of this key is evidence of a newer value.
 */
export function watchArabicFontScaleMirror(): () => void {
  const onStorageEvent = (event: StorageEvent) => {
    // key === null means Storage.clear(); any other foreign key is noise.
    if (event.key !== null && event.key !== ARABIC_FONT_SCALE_STORAGE_KEY) {
      return;
    }
    clientScale = readArabicFontScale(window.localStorage);
    applyArabicFontScale(document.documentElement, clientScale);
    emitChange();
  };
  window.addEventListener("storage", onStorageEvent);
  return () => window.removeEventListener("storage", onStorageEvent);
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): ArabicFontScale {
  clientScale ??= readArabicFontScale(window.localStorage);
  return clientScale;
}

/**
 * Test-only: forget the in-memory client snapshot so the next read re-seeds
 * from the mirror, recreating the fresh-page-load precondition between
 * tests. No production path may call this — during a session the snapshot
 * is deliberately authoritative over the (possibly unwritable) mirror.
 */
export function forgetClientArabicFontScaleForTests(): void {
  clientScale = null;
}

function getServerSnapshot(): ArabicFontScale {
  return DEFAULT_ARABIC_FONT_SCALE;
}

/**
 * Counts user-initiated scale writes so an in-flight reconcile can detect
 * that its Dexie read went stale mid-await and must not clobber the user's
 * just-made choice.
 */
let userWriteCount = 0;

/**
 * Reconcile the durable (Dexie) value into the localStorage mirror and the
 * document, notifying subscribed components. Called once at app start by
 * the initializer. Never throws: without IndexedDB the mirror value keeps
 * applying unchanged.
 */
export async function reconcileArabicFontScaleFromDb(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const observedWrites = userWriteCount;
  try {
    // Device-global (owner null): runs at the app root before the Auth session
    // resolves; the font-scale mirror is device-level (applies before
    // hydration). A signed-in account's pulled scale is carried by the mirror
    // force-write on pull (R2-F5), not by this pre-auth Dexie read.
    const { effective, restoreMirror } = await syncArabicFontScale(
      getSafwaDb(),
      window.localStorage,
      Date.now,
      null,
    );
    if (userWriteCount !== observedWrites) {
      // The user picked a scale while the read was in flight; their write
      // is newer than what was read (and persistScaleDurably is already
      // carrying it into Dexie) — do not revert it.
      return;
    }
    clientScale = effective;
    if (restoreMirror) {
      // Only a cleared/invalid mirror is rewritten from the durable copy.
      // A fresh guest with NO value anywhere gets no manufactured
      // "default" record — absent and explicitly-default stay distinct.
      writeArabicFontScale(window.localStorage, effective);
    }
    applyArabicFontScale(document.documentElement, effective);
    emitChange();
  } catch {
    // Dexie unavailable (private mode, quota): the mirror still applies.
  }
}

/**
 * Persist a user-chosen scale durably. Fire-and-forget from the setter —
 * the synchronous mirror write has already updated the UI; a Dexie failure
 * only weakens durability, never the current session.
 */
async function persistScaleDurably(
  next: ArabicFontScale,
  owner: LocalOwnerId,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    // R2-F1/R2-F3: stamp + enqueue under the AUTH owner so a signed-in
    // account's scale change syncs (and stores as the account's); the
    // device-global mirror remains the pre-hydration display source.
    await persistArabicFontScale(
      getSafwaDb(),
      next,
      window.localStorage,
      navigator.storage,
      {},
      owner,
    );
  } catch {
    // Same rationale as reconcile: durable write is best-effort.
  }
}

/**
 * Adopt a SERVER-AUTHORITATIVE pulled scale (§23 account-wins, R2-F5). Unlike
 * `reconcileArabicFontScaleFromDb` — which protects a possibly-newer,
 * interrupted LOCAL write and so treats a valid mirror as authoritative — a
 * value pulled from the account IS canonical and MUST win: force the mirror,
 * the in-memory snapshot, the applied CSS scale, and notify subscribers so a
 * mounted control updates live (not only after a reload). Deliberately does NOT
 * bump `userWriteCount` (this is not a user action; a concurrent reconcile
 * would merely re-derive the same durable value). No-op outside the browser.
 */
export function adoptPulledArabicFontScale(scale: ArabicFontScale): void {
  if (typeof window === "undefined") return;
  clientScale = scale;
  writeArabicFontScale(window.localStorage, scale);
  applyArabicFontScale(document.documentElement, scale);
  emitChange();
}

export function useArabicFontScale() {
  const resolveOwner = useResolveOwner();
  const scale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Keep the CSS custom property in sync with the current value.
  useEffect(() => {
    applyArabicFontScale(document.documentElement, scale);
  }, [scale]);

  const setScale = useCallback(
    (next: ArabicFontScale) => {
      userWriteCount += 1;
      // In-memory first: the user's choice must hold even if the mirror
      // write below fails (the durable Dexie write still carries it).
      clientScale = next;
      writeArabicFontScale(window.localStorage, next);
      applyArabicFontScale(document.documentElement, next);
      emitChange();
      // ARCH-002: resolve the owner at action time (see useResolveOwner) so a
      // scale picked before the session resolves is not stamped as a guest's.
      void resolveOwner().then((owner) => persistScaleDurably(next, owner));
    },
    [resolveOwner],
  );

  const reset = useCallback(() => {
    setScale(DEFAULT_ARABIC_FONT_SCALE);
  }, [setScale]);

  return { scale, setScale, reset };
}
