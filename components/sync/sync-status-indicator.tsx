"use client";

/**
 * Phase 16 §20 — the unobtrusive, authenticated-only sync-status indicator.
 * Reads the single source of truth (useSyncStatus) and renders one of the
 * documented states: Synced / Syncing / Pending N / Offline / Attention needed /
 * Sync unavailable. It NEVER shows raw ids, stack traces or SQL — only honest,
 * human wording — and it never blocks local study (it is display-only, plus a
 * manual retry for the one recoverable-failure state).
 *
 * Accessibility: a single stable `role="status" aria-live="polite"` region
 * announces each transition ONCE (concise text, so no screen-reader spam). The
 * attention state is a keyboard-accessible menu whose detail explains the issue
 * and offers a retry. Guests see nothing here (account sync is offered by the
 * account menu). Icon-only at ≤320px; the text label appears from `sm` up.
 */
import {
  Ban,
  Check,
  CloudOff,
  CloudUpload,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { useOptionalSyncStatus } from "@/components/sync/sync-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { SyncStatus } from "@/modules/sync/client/status";

/** The concise, screen-reader label for each state (announced once per change). */
function srLabelFor(status: SyncStatus): string {
  switch (status.kind) {
    case "syncing":
      return "Syncing your progress";
    case "synced":
      return "Progress synced";
    case "pending":
      return `${status.pendingCount} ${status.pendingCount === 1 ? "change" : "changes"} waiting to sync`;
    case "offline":
      return "Offline — your progress will sync when you reconnect";
    case "attention":
      return "Sync needs attention";
    case "disabled":
      return "Account sync is unavailable";
    default:
      return "";
  }
}

type Presentation = {
  Icon: typeof Check;
  /** Short visible label (from `sm` up). */
  label: string;
  spin?: boolean;
  className?: string;
};

/** Visible presentation for the non-interactive (non-attention) states. */
function presentationFor(status: SyncStatus): Presentation {
  switch (status.kind) {
    case "syncing":
      return { Icon: Loader2, label: "Syncing", spin: true };
    case "synced":
      return { Icon: Check, label: "Synced" };
    case "pending":
      return { Icon: CloudUpload, label: `${status.pendingCount} pending` };
    case "offline":
      return { Icon: CloudOff, label: "Offline" };
    case "disabled":
      return { Icon: Ban, label: "Sync off" };
    default:
      return { Icon: Check, label: "" };
  }
}

export function SyncStatusIndicator() {
  const sync = useOptionalSyncStatus();

  // Rendered outside a SyncProvider (e.g. an isolated header render) → nothing.
  if (sync === null) return null;
  const { status, retry } = sync;

  // Guests see nothing here — account sync is offered by the account menu.
  if (status.kind === "guest") return null;

  // One stable live region (always the first child for a signed-in user) so a
  // transition updates its text in place and is announced exactly once.
  const liveRegion = (
    <span role="status" aria-live="polite" className="sr-only">
      {srLabelFor(status)}
    </span>
  );

  if (status.kind === "attention") {
    return (
      <>
        {liveRegion}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-amber-700 hover:text-amber-800 dark:text-amber-500 dark:hover:text-amber-400"
            >
              <TriangleAlert aria-hidden className="size-4" />
              <span className="hidden text-xs font-medium sm:inline">
                Attention
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-72">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">Sync needs attention</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Some recent progress hasn’t reached the server yet. It’s saved
                safely on this device — you can keep studying.
              </p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-9 font-medium"
              onSelect={() => retry()}
            >
              <RefreshCw aria-hidden className="size-4" />
              Retry sync
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
  }

  const { Icon, label, spin, className } = presentationFor(status);
  return (
    <>
      {liveRegion}
      <span
        className={cn(
          "text-muted-foreground inline-flex items-center gap-1.5 px-1 text-xs",
          className,
        )}
      >
        <Icon aria-hidden className={cn("size-4", spin && "animate-spin")} />
        <span className="hidden sm:inline">{label}</span>
      </span>
    </>
  );
}
