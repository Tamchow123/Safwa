"use client";

/**
 * Account menu (Phase 15, phases-15.md §37; Phase 18 §5). Guest and signed-in
 * states are both derived from a single `useSession()` read, never a separate
 * "is auth available" check. Never displays the raw user id — only the account
 * email.
 *
 * Phase 15 deliberately collapsed three cases into the guest links: a genuine
 * guest, a still-pending first read, and a session read that errored. That was
 * right when the third case meant `AUTH_ENABLED=false` or a momentarily
 * unreachable endpoint — the guest links render immediately and never block on
 * the fetch.
 *
 * Once the app is installable it is also wrong, for one of those cases. An
 * offline cold boot IS the errored read, and a learner who is signed in and
 * has simply lost the network would be shown "Sign in / Create account" — an
 * invitation to do the one thing that cannot work, phrased as though their
 * account were gone. So when the read has FAILED and this device remembers an
 * owner, the menu says **Offline** instead: no CTA, no claim about the account,
 * just the true reason nothing more can be said.
 *
 * Two cases deliberately keep the Phase 15 behaviour, and both matter:
 * a still-PENDING read is not a failed one, so an ordinary cold start never
 * flashes "Offline" before the session resolves; and with no remembered owner
 * a failed read still shows the guest links, because a first-time visitor on a
 * broken network is, as far as anyone knows, a guest.
 */
import { LogOut, User, WifiOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { signOutAndClearLocalState } from "@/components/account/sign-out-action";
import { useLocalOwner } from "@/components/sync/use-local-owner";
import { useSession } from "@/modules/auth/client";
import { classifySessionIdentity } from "@/modules/auth/session-identity";
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
  const identity = classifySessionIdentity(session);
  // The local owner, which resolves an `unknown` session to this device's
  // remembered account. Non-null with no `session.data` is precisely "signed
  // in, but the server could not be reached".
  const rememberedOwner = useLocalOwner();
  const [signingOut, setSigningOut] = useState(false);

  if (!session.data) {
    // `unknown` covers BOTH "the read failed" and "the read is still in
    // flight", and only the first is offline. Excluding `isPending` is what
    // stops every ordinary cold start flashing "Offline" at a signed-in
    // learner before their session resolves — a false claim about the network,
    // made at the one moment it is most likely to be believed.
    //
    // Classified once, here, and both facts derived from it. `rememberedOwner`
    // being non-null happens to imply `unknown` today (useLocalOwner returns
    // null outright for a `guest` verdict), but that invariant lives in another
    // file and nothing enforces it from here — so this does not lean on it.
    const readFailed = !session.isPending && identity.kind === "unknown";

    if (readFailed && rememberedOwner !== null) {
      return (
        <span
          className="text-muted-foreground flex items-center gap-1.5 px-2 text-sm"
          // Announced politely rather than assertively: losing the network is
          // not an error the learner must act on, and study continues.
          role="status"
        >
          <WifiOff aria-hidden className="size-4" />
          Offline
        </span>
      );
    }

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

  // The signed-in id this menu is already rendering for. Passing it into the
  // sign-out helper means the owner-scoped cleanup (§11) never has to re-read
  // the session to scope itself; the helper still falls back to a bounded
  // lookup for any caller that cannot supply it.
  const departingUserId = session.data?.user?.id ?? null;

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      // Global header sign-out — the app's primary sign-out affordance. Routes
      // through the ONE shared helper so this path also removes the previous
      // account's local state on a shared device (SEC-002-T15d), exactly like
      // the /account page button.
      await signOutAndClearLocalState(departingUserId);
    } catch {
      // Server call failed; the local sweeps ran regardless (Phase 18). Same
      // message as the /account button, because it is the same situation.
      toast("Signed out on this device", {
        description:
          "We couldn't reach the server, so your session may still be open on others. Try again once you're back online.",
      });
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
