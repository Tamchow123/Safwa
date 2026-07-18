import { MixedSession } from "@/components/study/mixed-session";
import { PageHeader } from "@/components/page-header";

export default function MixedSessionPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Start studying"
        description="Due reviews first, then weak items, then new words — no setup needed. Your progress is saved on this device."
      />
      <MixedSession />
    </div>
  );
}
