import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function StudyPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Study"
        description="Flashcards, quizzes and mixed revision will start here."
      />
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          Study modes arrive with the study-engine and flashcard phases.
        </CardContent>
      </Card>
    </div>
  );
}
