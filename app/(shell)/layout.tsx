import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { DeletedAccountCleanup } from "@/components/account/deleted-account-cleanup";
import { GuestMergeDialog } from "@/components/sync/guest-merge-dialog";
import { GuestMergeProvider } from "@/components/sync/guest-merge-provider";
import { SyncProvider } from "@/components/sync/sync-provider";

export default function ShellLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <SyncProvider>
      {/*
        Inside SyncProvider, and the nesting is load-bearing: the merge's
        post-merge rebase runs through that provider's `syncNow`, so it inherits
        the sync controller's disabled and auth-lost back-offs rather than
        calling the server behind them (ARCH-002). Self-gating like its sibling —
        with no signed-in session it resolves to "nothing to offer" and never
        reads guest data — so mounting it shell-wide is safe.
      */}
      <GuestMergeProvider>
        <AppShell>{children}</AppShell>
        {/*
          Shell-wide, so the offer reaches a learner wherever they landed after
          signing in. It renders nothing at all unless the flow has something to
          say, so it costs a mounted component and no markup the rest of the time.
        */}
        <GuestMergeDialog />
        {/*
          Runs only on the deletion callback URL; renders nothing ever.
          Suspense because it reads search params, which Next requires.
        */}
        <Suspense fallback={null}>
          <DeletedAccountCleanup />
        </Suspense>
      </GuestMergeProvider>
    </SyncProvider>
  );
}
