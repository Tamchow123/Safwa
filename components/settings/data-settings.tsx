"use client";

import { useState } from "react";
import { toast } from "sonner";

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
          As a guest, your settings and study progress are stored only in this
          browser. Clearing site data erases them, and browsers may evict local
          data under storage pressure. Download a copy anytime.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}
