import { Suspense } from "react";

import { SavedVocabularyClient } from "@/components/collections/saved-vocabulary-client";
import { PageHeader } from "@/components/page-header";

export default function SavedVocabularyPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Saved vocabulary"
        description="Bookmarks and custom lists you're building for focused practice."
      />
      <Suspense>
        <SavedVocabularyClient />
      </Suspense>
    </div>
  );
}
