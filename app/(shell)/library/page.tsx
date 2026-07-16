import { Suspense } from "react";

import { LibraryPageClient } from "@/components/library/library-page-client";
import { PageHeader } from "@/components/page-header";

export default function LibraryPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Library"
        description="Browse and search the full vocabulary."
      />
      <Suspense>
        <LibraryPageClient />
      </Suspense>
    </div>
  );
}
