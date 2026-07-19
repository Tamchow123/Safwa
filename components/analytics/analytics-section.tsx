/**
 * The ONE section/Card/heading wrapper shared by the Dashboard and Progress
 * pages (Phase 12 §16–§17, §19): a labelled `<section>` around a Card whose
 * header holds the page's h2, so the heading hierarchy and card idiom stay
 * identical everywhere and future changes land in one place.
 */
import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function AnalyticsSection({
  headingId,
  title,
  children,
}: {
  headingId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={headingId} className="text-base font-semibold">
              {title}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </section>
  );
}
