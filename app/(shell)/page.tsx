import { Dashboard } from "@/components/dashboard/dashboard";
import { PageHeader } from "@/components/page-header";
import { RegisterPrompt } from "@/components/register-prompt";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Your study overview: progress, streaks and what's due today."
      />
      <RegisterPrompt />
      <Dashboard />
    </div>
  );
}
