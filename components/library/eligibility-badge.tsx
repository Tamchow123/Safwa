import { Badge } from "@/components/ui/badge";

/**
 * Per-field quiz-eligibility indicator: whether the field is ever used in
 * quizzes — never whether the learner has been quizzed on it (Phase 18.5; the
 * entry page's progress card says that). Always textual — never colour
 * alone — so the state is available to every reader.
 */
export function EligibilityBadge({ eligible }: { eligible: boolean }) {
  return (
    <Badge
      variant={eligible ? "secondary" : "outline"}
      className="text-[10px] tracking-wide uppercase"
    >
      {eligible ? "In quizzes" : "Not in quizzes"}
    </Badge>
  );
}
