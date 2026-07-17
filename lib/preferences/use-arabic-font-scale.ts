"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  applyArabicFontScale,
  ARABIC_FONT_SCALE_STORAGE_KEY,
  DEFAULT_ARABIC_FONT_SCALE,
  readArabicFontScale,
  writeArabicFontScale,
  type ArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";
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
    const { effective, restoreMirror } = await syncArabicFontScale(
      getSafwaDb(),
      window.localStorage,
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
async function persistScaleDurably(next: ArabicFontScale): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    await persistArabicFontScale(
      getSafwaDb(),
      next,
      window.localStorage,
      navigator.storage,
    );
  } catch {
    // Same rationale as reconcile: durable write is best-effort.
  }
}

export function useArabicFontScale() {
  const scale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Keep the CSS custom property in sync with the current value.
  useEffect(() => {
    applyArabicFontScale(document.documentElement, scale);
  }, [scale]);

  const setScale = useCallback((next: ArabicFontScale) => {
    userWriteCount += 1;
    // In-memory first: the user's choice must hold even if the mirror
    // write below fails (the durable Dexie write still carries it).
    clientScale = next;
    writeArabicFontScale(window.localStorage, next);
    applyArabicFontScale(document.documentElement, next);
    emitChange();
    void persistScaleDurably(next);
  }, []);

  const reset = useCallback(() => {
    setScale(DEFAULT_ARABIC_FONT_SCALE);
  }, [setScale]);

  return { scale, setScale, reset };
}
