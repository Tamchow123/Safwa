import { PageHeader } from "@/components/page-header";
import { WeakAreasPageClient } from "@/components/progress/weak-areas-page-client";

export default function WeakAreasPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Weak areas"
        description="Practice priorities based on your recent first attempts, review lapses and recency."
      />
      <WeakAreasPageClient />
    </div>
  );
}
