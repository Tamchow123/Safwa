import { PageHeader } from "@/components/page-header";
import { ProgressDetails } from "@/components/progress/progress-details";

export default function ProgressPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Progress"
        description="Exact mastery counts by skill, form and bāb, plus your streaks and recent activity."
      />
      <ProgressDetails />
    </div>
  );
}
