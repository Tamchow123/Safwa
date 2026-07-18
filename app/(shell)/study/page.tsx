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
        description="Start a zero-setup mixed session, or choose a specific study mode."
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Start studying</h2>
          </CardTitle>
          <CardDescription>
            One tap, no setup: due reviews first, then weak items, then new
            words — within your daily targets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="min-h-11">
            <Link href="/study/mixed" data-testid="start-studying">
              Start studying
            </Link>
          </Button>
        </CardContent>
      </Card>
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
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/study/flashcards" data-testid="start-flashcards">
              Start flashcards
            </Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Multiple choice</h2>
          </CardTitle>
          <CardDescription>
            Choose the correct answer from four options, in either direction
            (Arabic → English or English → Arabic). Your progress is saved on
            this device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/study/mc" data-testid="start-mc-quiz">
              Start multiple choice
            </Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Bāb quiz</h2>
          </CardTitle>
          <CardDescription>
            Identify which bāb each verb follows — answers shown as Arabic
            pattern pairs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/study/bab" data-testid="start-bab-quiz">
              Start bāb quiz
            </Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Root quiz</h2>
          </CardTitle>
          <CardDescription>
            Identify each verb&apos;s three-radical root from four options.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/study/root" data-testid="start-root-quiz">
              Start root quiz
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
