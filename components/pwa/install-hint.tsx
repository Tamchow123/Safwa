"use client";

/**
 * Phase 18, slice 11 — the install offer.
 *
 * Two shapes, because the two platforms differ in kind and not in degree:
 * Chromium hands the page a deferred prompt it can trigger, and iOS hands it
 * nothing at all, so the only honest thing to do there is describe the gesture.
 * `modules/pwa/install-hint.ts` decides which; this renders it.
 *
 * Mounted in the shell layout rather than the root one. A sign-in page is the
 * wrong moment to suggest installing an app the visitor has not used yet.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Share, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  isIosLike,
  isRunningInstalled,
  readInstallHintDismissed,
  resolveInstallHint,
  writeInstallHintDismissed,
  type InstallHint,
} from "@/modules/pwa/install-hint";

/**
 * The `beforeinstallprompt` event, which TypeScript's DOM library does not
 * declare because it is not in any specification — it is a Chromium extension
 * the standards discussion has not adopted. Declared here, narrowly, at the one
 * place that uses it.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
};

/** The ambient `localStorage`, or null — the access itself can throw. */
function ambientStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The hint, as an external store rather than as state synchronised by an
 * effect.
 *
 * Every input is a browser fact — the user agent, the display mode,
 * `localStorage`, and an event Chromium fires whenever it decides the app is
 * installable, routinely long after load. None of them exist during the
 * prerender of the ~20 static routes this app ships, so reading them during
 * render would be a hydration mismatch, and writing them from an effect would
 * be a cascading render (which `react-hooks/set-state-in-effect` rejects, for
 * the same reason).
 *
 * `useSyncExternalStore` is the shape that fits: the server snapshot is
 * `"none"`, so the markup matches; the client snapshot is computed on first
 * read and cached, so it is stable within a render pass; and the two events
 * invalidate it rather than pushing a value in.
 *
 * Created per mounted component (`useMemo`), not at module scope, so nothing
 * leaks between instances or between tests.
 */
function createInstallHintStore() {
  const listeners = new Set<() => void>();
  let prompt: BeforeInstallPromptEvent | null = null;
  let installedByEvent = false;
  let dismissed = false;
  let cached: InstallHint | null = null;

  const invalidate = () => {
    cached = null;
    for (const listener of [...listeners]) listener();
  };

  const compute = (): InstallHint =>
    resolveInstallHint({
      installed:
        installedByEvent ||
        isRunningInstalled({
          displayModeStandalone: window.matchMedia("(display-mode: standalone)")
            .matches,
          navigatorStandalone: (navigator as { standalone?: boolean })
            .standalone,
        }),
      dismissed: dismissed || readInstallHintDismissed(ambientStorage()),
      iosLike: isIosLike({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
      }),
      promptAvailable: prompt !== null,
    });

  const onBeforeInstallPrompt = (event: Event) => {
    // `preventDefault` is what keeps Chromium's own mini-infobar from appearing
    // and hands the timing to this component. The event object is retained
    // because it is the only thing that can trigger the real flow — and it can
    // be used exactly once.
    event.preventDefault();
    prompt = event as BeforeInstallPromptEvent;
    invalidate();
  };

  // Fires when the install completes by any route, including the browser's own
  // menu — so the offer disappears even though this component never triggered
  // anything.
  const onInstalled = () => {
    prompt = null;
    installedByEvent = true;
    invalidate();
  };

  return {
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
        window.addEventListener("appinstalled", onInstalled);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          window.removeEventListener(
            "beforeinstallprompt",
            onBeforeInstallPrompt,
          );
          window.removeEventListener("appinstalled", onInstalled);
        }
      };
    },
    getSnapshot(): InstallHint {
      cached ??= compute();
      return cached;
    },
    /** No browser here — and no markup, so nothing can mismatch. */
    getServerSnapshot(): InstallHint {
      return "none";
    },
    /** The prompt, consumed: it is single-use, so it is handed over once. */
    takePrompt(): BeforeInstallPromptEvent | null {
      const taken = prompt;
      prompt = null;
      invalidate();
      return taken;
    },
    dismiss(): void {
      dismissed = true;
      writeInstallHintDismissed(ambientStorage());
      invalidate();
    },
  };
}

export function InstallHint() {
  const store = useMemo(() => createInstallHintStore(), []);
  const hint = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  const install = useCallback(() => {
    const prompt = store.takePrompt();
    if (prompt === null) return;
    // Not awaited for a decision: the outcome is the browser's to report, and
    // `appinstalled` is what tells us it happened. The offer closes either way
    // — a learner who has just declined an install dialog does not want the
    // same suggestion still sitting there.
    void prompt.prompt().catch(() => {
      // A prompt already used, or no longer valid, throws. There is nothing to
      // recover: the browser's own install control still exists.
    });
  }, [store]);

  const dismiss = useCallback(() => {
    store.dismiss();
  }, [store]);

  if (hint === "none") return null;

  return (
    <Card className="mx-auto mb-4 w-full max-w-md">
      <CardContent className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">Install Safwa on this device</p>
          {hint === "prompt" ? (
            <>
              <p className="text-muted-foreground text-sm">
                It opens without browser chrome and keeps working offline.
              </p>
              <Button onClick={install} className="min-h-11 w-full">
                Install
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Tap{" "}
              <Share aria-hidden className="inline size-4 align-text-bottom" />
              <span className="sr-only">Share</span> Share, then{" "}
              <span className="text-foreground font-medium">
                Add to Home Screen
              </span>
              . It then opens without browser chrome and keeps working offline.
            </p>
          )}
        </div>
        {/*
          `min-h-11 min-w-11` is the 44px hit area §8 requires, applied as
          padding around a 16px icon rather than by growing the icon — the
          control looks identical and is reliably hittable with a thumb.
        */}
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          className="min-h-11 min-w-11"
        >
          <X aria-hidden />
          <span className="sr-only">Dismiss install suggestion</span>
        </Button>
      </CardContent>
    </Card>
  );
}
