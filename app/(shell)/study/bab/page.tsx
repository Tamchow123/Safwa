import { EntryQuizSession } from "@/components/study/entry-quiz-session";
import { PageHeader } from "@/components/page-header";

export default function BabQuizPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Bāb quiz"
        description="Identify which bāb each verb follows. Answers are shown as Arabic pattern pairs. Your progress is saved on this device."
      />
      <EntryQuizSession skill="bab_identification" />
    </div>
  );
}
