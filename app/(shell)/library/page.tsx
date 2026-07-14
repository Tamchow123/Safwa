import { ContentFoundationStatus } from "@/components/content/content-foundation-status";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function LibraryPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Library"
        description="Browse and search the full vocabulary."
      />
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          The vocabulary library arrives with the library phase; below is the
          Phase 3 content-foundation demonstration.
        </CardContent>
      </Card>
      <ContentFoundationStatus />
    </div>
  );
}
