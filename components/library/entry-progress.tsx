"use client";

/**
 * The entry page's "Your progress" card (Phase 18.5): every skill Start
 * studying teaches this word, in order, with its current state and — for the
 * ones not started yet — whether it is next up or still locked; any other
 * skill already practised in a focused mode; and the word's overall state.
 *
 * The values come from `useEntryProgress` — the same rules, and the same
 * stored state, Start studying plans from — so the two never disagree.
 */
import { useEntryProgress } from "@/components/library/use-entry-progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SOURCE_FORM_METADATA } from "@/lib/form-metadata";
import { LEARNER_STATE_LABELS, SKILL_LABELS } from "@/lib/skill-labels";
import type { LearnerEntry } from "@/modules/content/schema";
import type { DerivedComponent } from "@/modules/study-engine/components";
import type {
  EntryChainSkillProgress,
  EntryProgress,
  EntrySkillProgress,
} from "@/modules/study-session/entry-progress";

/** "Meaning recognition (Arabic → English) · māḍī", or "Bāb identification". */
function skillLabel(component: DerivedComponent): string {
  const skill = SKILL_LABELS[component.skillType];
  return component.sourceField
    ? `${skill} · ${SOURCE_FORM_METADATA[component.sourceField].name}`
    : skill;
}

function SkillRow({
  skill,
  status,
}: {
  skill: EntrySkillProgress;
  status?: EntryChainSkillProgress["status"];
}) {
  const { component, state } = skill;
  let badge: { text: string; variant: "secondary" | "outline" | "default" };
  if (status === "next") badge = { text: "Next up", variant: "default" };
  else if (status === "locked") badge = { text: "Locked", variant: "outline" };
  else badge = { text: LEARNER_STATE_LABELS[state], variant: "secondary" };
  return (
    <li
      className="flex items-center justify-between gap-3 py-2 text-sm"
      data-testid="entry-progress-skill"
      data-skill-type={component.skillType}
      data-source-field={component.sourceField ?? ""}
      data-status={status ?? "started"}
    >
      <span className={status === "locked" ? "text-muted-foreground" : ""}>
        {skillLabel(component)}
      </span>
      <Badge variant={badge.variant} className="shrink-0 font-normal">
        {badge.text}
      </Badge>
    </li>
  );
}

export function EntryProgressCard({
  entry,
  headingLevel = "h2",
}: {
  entry: LearnerEntry;
  /** h3 under the in-session entry dialog's own title. */
  headingLevel?: "h2" | "h3";
}) {
  const { state, retry } = useEntryProgress(entry);
  const Heading = headingLevel;
  return (
    <Card data-testid="entry-progress">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <Heading className="text-base font-semibold">Your progress</Heading>
          {state.status === "ready" ? (
            <Badge
              variant="outline"
              className="font-normal"
              data-testid="entry-progress-word-state"
            >
              {LEARNER_STATE_LABELS[state.progress.wordState]}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === "loading" ? (
          <div role="status" aria-label="Loading your progress">
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        ) : state.status === "error" ? (
          <div role="alert" className="space-y-3">
            <p className="text-destructive text-sm">{state.message}</p>
            <Button type="button" variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : (
          <ProgressBody
            progress={state.progress}
            subheading={headingLevel === "h2" ? "h3" : "h4"}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ProgressBody({
  progress,
  subheading,
}: {
  progress: EntryProgress;
  subheading: "h3" | "h4";
}) {
  const Subheading = subheading;
  return (
    <>
      {progress.chain.length > 0 ? (
        <>
          <p className="text-muted-foreground text-sm">
            Start studying teaches these one at a time, in this order. Each
            unlocks once the one before it has been answered correctly on two
            separate days.
          </p>
          <ol className="divide-y" data-testid="entry-progress-chain">
            {progress.chain.map((skill) => (
              <SkillRow
                key={skill.component.key}
                skill={skill}
                status={skill.status}
              />
            ))}
          </ol>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Start studying does not teach this word. You can practise it in the
          focused modes on the Study page.
        </p>
      )}
      {progress.alsoPractised.length > 0 ? (
        <div className="space-y-1">
          <Subheading className="text-sm font-medium">
            Also practised
          </Subheading>
          <ul className="divide-y" data-testid="entry-progress-also">
            {progress.alsoPractised.map((skill) => (
              <SkillRow key={skill.component.key} skill={skill} />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
