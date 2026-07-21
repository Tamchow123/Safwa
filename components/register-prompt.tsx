"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getSafwaDb } from "@/modules/content/db";
import { peekDeviceProfile } from "@/modules/profile/device";
import { GUEST_STATE_CHANGED_EVENT } from "@/modules/profile/persistence";
import {
  dismissRegisterPrompt,
  isRegisterPromptDismissed,
} from "@/modules/profile/settings";

/**
 * Gentle, dismissible note for guests whose progress lives only on this
 * device (PRODUCT_REQUIREMENTS §4.7). Shown once a device profile exists
 * (i.e. the guest has durable local state) and until dismissed; the
 * dismissal itself is durable. Accounts arrive in a later phase, so the
 * prompt points at the export safety valve rather than a sign-up flow.
 *
 * First progress can happen while the prompt is already mounted (e.g. a
 * theme change from the header on the dashboard), so besides the mount
 * check it re-checks whenever the durability boundary announces guest
 * state via GUEST_STATE_CHANGED_EVENT — the prompt appears in place, no
 * navigation or reload needed.
 */
export function RegisterPrompt() {
  const [visible, setVisible] = useState(false);
  // A dismissal in this session must win over any concurrently running
  // re-check (the dismissal's own durable write fires the event before
  // the dismissed flag is readable back).
  const dismissedThisSession = useRef(false);

  useEffect(() => {
    if (typeof indexedDB === "undefined") return;
    let cancelled = false;
    const check = () => {
      void (async () => {
        try {
          const db = getSafwaDb();
          const [profile, dismissed] = await Promise.all([
            peekDeviceProfile(db),
            isRegisterPromptDismissed(db),
          ]);
          if (
            !cancelled &&
            !dismissedThisSession.current &&
            profile !== null &&
            !dismissed
          ) {
            setVisible(true);
          }
        } catch {
          // No local state readable — nothing to prompt about.
        }
      })();
    };
    check();
    window.addEventListener(GUEST_STATE_CHANGED_EVENT, check);
    return () => {
      cancelled = true;
      window.removeEventListener(GUEST_STATE_CHANGED_EVENT, check);
    };
  }, []);

  if (!visible) return null;

  async function dismiss() {
    dismissedThisSession.current = true;
    setVisible(false);
    try {
      await dismissRegisterPrompt(getSafwaDb());
    } catch {
      // Dismissal durability is best-effort; the prompt stays hidden for
      // this session either way.
    }
  }

  return (
    <Card data-testid="register-prompt" role="note">
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">
            Your progress stays on this device
          </h2>
        </CardTitle>
        <CardDescription>
          You are studying as a guest, so your progress and settings are stored
          only in this browser. Clearing site data erases them. Create a Safwa
          account for backup and sync, or download a copy of your data anytime.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        <Button asChild className="min-h-11">
          <Link href="/register">Create an account</Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/settings">Export my data in Settings</Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={dismiss}
        >
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}
