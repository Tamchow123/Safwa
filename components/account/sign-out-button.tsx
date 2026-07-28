"use client";

import { useState } from "react";
import { signOutAndClearLocalState } from "@/components/account/sign-out-action";
import { Button } from "@/components/ui/button";
import { useSession } from "@/modules/auth/client";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const session = useSession();
  // The signed-in id this page is rendering for. Passing it in means the
  // owner-scoped cleanup (phases-17.md §11) never falls back to re-reading the
  // session, exactly as the header menu does.
  const departingUserId = session.data?.user?.id ?? null;

  async function handleSignOut() {
    if (pending) return;
    setPending(true);
    try {
      // The single sign-out path: end the session, then best-effort wipe the
      // previous account's local state + UI-preference mirrors (SEC-002-T15d).
      await signOutAndClearLocalState(departingUserId);
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
