import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Your study overview will live here."
      />
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          Progress, streaks and due reviews arrive with the progress dashboard
          phase.
        </CardContent>
      </Card>
    </div>
  );
}
