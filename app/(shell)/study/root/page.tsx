import { EntryQuizSession } from "@/components/study/entry-quiz-session";
import { PageHeader } from "@/components/page-header";

export default function RootQuizPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Root quiz"
        description="Identify each verb's three-radical root. Your progress is saved on this device."
      />
      <EntryQuizSession skill="root_identification" />
    </div>
  );
}
