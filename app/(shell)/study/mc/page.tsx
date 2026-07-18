import { McQuizSession } from "@/components/study/mc-quiz-session";
import { PageHeader } from "@/components/page-header";

export default function McQuizPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Multiple choice"
        description="Pick the correct answer from four options. Your progress is saved on this device."
      />
      <McQuizSession />
    </div>
  );
}
