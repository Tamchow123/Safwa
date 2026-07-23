"use client";

import { useState } from "react";
import { signOutAndClearLocalState } from "@/components/account/sign-out-action";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    if (pending) return;
    setPending(true);
    try {
      // The single sign-out path: end the session, then best-effort wipe the
      // previous account's local state + UI-preference mirrors (SEC-002-T15d).
      await signOutAndClearLocalState();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="destructive"
      className="min-h-11"
      disabled={pending}
      onClick={() => void handleSignOut()}
    >
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
