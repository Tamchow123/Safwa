import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function StudyPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Study"
        description="Choose a study mode. More modes arrive in upcoming phases."
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Flashcards</h2>
          </CardTitle>
          <CardDescription>
            Flip cards between Arabic and English and rate yourself. Your
            progress is saved on this device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="min-h-11">
            <Link href="/study/flashcards" data-testid="start-flashcards">
              Start flashcards
            </Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="text-muted-foreground text-sm">
          Multiple-choice quizzes, bāb and root drills, and mixed revision
          arrive in later phases.
        </CardContent>
      </Card>
    </div>
  );
}
