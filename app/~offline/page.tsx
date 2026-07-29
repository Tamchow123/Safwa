import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The offline fallback page (Phase 18, slice 10).
 *
 * Reached only when a navigation is BOTH uncached and unreachable — the
 * document rule is `NetworkFirst`, so any page the learner has opened before
 * still comes back from the document cache and never gets here.
 *
 * It sits directly under the root layout rather than inside `(shell)`, which is
 * the point of it: the shell mounts the sync providers and opens Dexie, and a
 * page whose whole job is to render when things are broken must not depend on
 * any of that. Nothing here is a client component and nothing fetches.
 *
 * `modules/pwa/cache-storage.ts` warms this URL into Cache Storage during the
 * worker's `install`, which is what makes it available on a route the learner
 * has never visited.
 */
export const metadata: Metadata = {
  title: "Offline",
  description: "Safwa is offline. Studying still works.",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <h1 className="text-lg font-semibold tracking-tight">
              You&rsquo;re offline
            </h1>
            <p className="text-muted-foreground text-sm">
              This page hasn&rsquo;t been opened on this device yet, so there
              was nothing saved to show you.
            </p>
          </div>
          <p className="text-muted-foreground text-sm">
            Studying still works offline. Your reviews are saved on this device
            and sent when you&rsquo;re back online — signing in, changing your
            account and downloading new vocabulary are the parts that need a
            connection.
          </p>
          {/*
            Home rather than a retry of the requested page, and a link rather
            than a button: this page has no client JavaScript, so it cannot
            read the URL the learner actually asked for (the address bar still
            shows it — the worker answered that request with this page). Home
            is the page most likely to be in the document cache, because it is
            where every session starts.
          */}
          <Link
            href="/"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "min-h-11 w-full",
            )}
          >
            Try again
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
