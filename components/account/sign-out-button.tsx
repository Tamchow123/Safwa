"use client";

import { useState } from "react";
import { signOut } from "@/modules/auth/client";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    if (pending) return;
    setPending(true);
    try {
      await signOut();
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
