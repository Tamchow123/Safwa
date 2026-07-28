"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useGuestMerge } from "@/components/sync/guest-merge-provider";
import { useResolveOwner } from "@/components/sync/use-local-owner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getSafwaDb } from "@/modules/content/db";
import {
  buildExportPayload,
  exportFilename,
  serializeExport,
  triggerJsonDownload,
} from "@/modules/profile/export";

/**
 * Guest data controls: the export-my-data safety valve. Guest state lives
 * only in this browser; even with persistent storage granted the browser
 * may evict it under extreme storage pressure, so a downloadable copy is
 * the guest's own backup.
 */
export function DataSettings() {
  const [exporting, setExporting] = useState(false);
  // The identity whose data is exported (R2-F3 / ARCH-001): a signed-in account
  // downloads only its own rows, a guest only the un-owned ones — never both.
  // Resolved at ACTION time (ARCH-005), not from a possibly-still-pending
  // session read: an export is a ONE-SHOT artifact, not a self-correcting live
  // view, so an owner that read as guest during the pending window would
  // permanently produce a file missing the account's own data — and the success
  // toast would give no hint anything was wrong.
  const resolveOwner = useResolveOwner();
  // The DEFERRED merge entry point (§19 "expose the deferred action later").
  // It appears only while there is still guest data to offer, so a learner who
  // pressed "Not now" can change their mind without signing out and back in.
  // Outside a provider it is simply absent, which is why the hook is the
  // non-throwing one.
  //
  // It calls `reconsider`, NOT `consent` (SEC-002): this button re-opens the
  // prompt with its counts, and the learner confirms there. A settings button
  // that started an upload directly would be a confirmation whose only
  // information was its own label.
  //
  // It covers BOTH states a learner can be left in with work outstanding
  // (REL-006): a deferred offer, and a merge that stopped with a retryable
  // failure. An earlier version narrowed this to `deferred` alone while fixing
  // the consent problem above, which silently removed the only place a
  // DISMISSED retryable error could be retried from — §19 asks the UI to
  // surface retryable failures and to expose the deferred action later, and a
  // learner who closes the failure notice needs both promises kept at once.
  const merge = useGuestMerge();
  const flowName = merge?.state.flow.name;
  const canReconsider = flowName === "deferred";
  // A retry is NOT a fresh consent: the learner already agreed, and part of the
  // merge may already be durable. It gets its own label and its own handler.
  const canRetry = flowName === "retryable-error";
  // A signed-in learner is not a guest, and the card's guest-only warning
  // beneath a merge offer reads as the app not knowing who they are (REL-005).
  const signedIn = merge?.state.session.status === "signed-in";

  async function exportData() {
    setExporting(true);
    try {
      const payload = await buildExportPayload(
        getSafwaDb(),
        Date.now,
        await resolveOwner(),
      );
      triggerJsonDownload(serializeExport(payload), exportFilename());
      toast("Data exported", {
        description: "Your study data was downloaded as a JSON file.",
      });
    } catch {
      toast("Export failed", {
        description:
          "Your data could not be read from this browser. Try again after reloading.",
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Your data</h2>
        </CardTitle>
        <CardDescription>
          {signedIn
            ? "Your study progress syncs to your account. You can also download a copy of what this browser holds at any time."
            : "As a guest, your settings and study progress are stored only in this browser. Clearing site data erases them, and browsers may evict local data under storage pressure. Download a copy anytime."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={exportData}
          disabled={exporting}
          data-testid="export-my-data"
        >
          {exporting ? "Preparing export…" : "Export my data"}
        </Button>
        {canReconsider && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={merge?.reconsider}
            data-testid="merge-guest-data"
          >
            Add my earlier progress to this account…
          </Button>
        )}
        {canRetry && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={merge?.retry}
            data-testid="retry-guest-merge"
          >
            Finish adding my earlier progress
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
