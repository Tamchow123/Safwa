"use client";

import { useState } from "react";
import { toast } from "sonner";

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

  async function exportData() {
    setExporting(true);
    try {
      const payload = await buildExportPayload(getSafwaDb());
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
