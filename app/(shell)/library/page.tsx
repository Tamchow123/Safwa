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
          The vocabulary library arrives with the content-pipeline and library
          phases.
        </CardContent>
      </Card>
    </div>
  );
}
