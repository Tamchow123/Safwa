import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function ProgressPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Progress"
        description="Mastery, streaks and weak areas will be tracked here."
      />
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          Progress analytics arrive with the dashboard and weak-areas phases.
        </CardContent>
      </Card>
    </div>
  );
}
