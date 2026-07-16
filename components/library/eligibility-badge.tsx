import { Badge } from "@/components/ui/badge";

/**
 * Per-field quiz-eligibility indicator. Always textual — never colour
 * alone — so the state is available to every reader.
 */
export function EligibilityBadge({ eligible }: { eligible: boolean }) {
  return (
    <Badge
      variant={eligible ? "secondary" : "outline"}
      className="text-[10px] tracking-wide uppercase"
    >
      {eligible ? "Quizzed" : "Not quizzed"}
    </Badge>
  );
}
