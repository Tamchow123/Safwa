"use client";

/**
 * Account menu (Phase 15, phases-15.md §37). Guest and signed-in states
 * are both derived from a single `useSession()` read, never a separate
 * "is auth available" check: a genuine guest, a session read that errored
 * (AUTH_ENABLED=false, the auth endpoint unreachable), and a still-pending
 * first read all resolve `data` to a falsy value, so this component
 * treats them identically — the guest links render immediately and never
 * block on, or wait for, the session fetch to settle. Never displays the
 * raw user id — only the account email.
 */
import { LogOut, User } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { signOutAndClearLocalState } from "@/components/account/sign-out-action";
import { useSession } from "@/modules/auth/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccountMenu() {
  const session = useSession();
  const [signingOut, setSigningOut] = useState(false);

  if (!session.data) {
    return (
      <div className="flex items-center gap-1">
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/register">Create account</Link>
        </Button>
      </div>
    );
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      // Global header sign-out — the app's primary sign-out affordance. Routes
      // through the ONE shared helper so this path also wipes the previous
      // account's local state on a shared device (SEC-002-T15d), exactly like
      // the /account page button.
      await signOutAndClearLocalState();
    } finally {
      setSigningOut(false);
    }
  }

  const email = session.data.user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <User aria-hidden className="size-5" />
          <span className="sr-only">Account</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-muted-foreground max-w-48 truncate font-normal">
          {email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">Account</Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
        >
          <LogOut aria-hidden className="size-4" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
