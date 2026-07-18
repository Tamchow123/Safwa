import { FlashcardSession } from "@/components/study/flashcard-session";
import { PageHeader } from "@/components/page-header";

export default function FlashcardsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Flashcards"
        description="Flip to reveal the answer, then rate how well you knew it."
      />
      <FlashcardSession />
    </div>
  );
}
