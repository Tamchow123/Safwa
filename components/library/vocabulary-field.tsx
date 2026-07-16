import { ArabicText } from "@/components/arabic-text";
import { EligibilityBadge } from "@/components/library/eligibility-badge";

/**
 * One labelled field on the detail page (dt/dd pair). Eligibility, when
 * provided, renders as visible text via EligibilityBadge; a missing value
 * renders the unavailable state instead of implying content exists.
 */
export function VocabularyField({
  label,
  value,
  arabic = false,
  eligible,
  unavailableText = "Not available",
  testId,
}: {
  label: string;
  value?: string;
  arabic?: boolean;
  /** Omit for fields with no quiz-eligibility concept (e.g. book page). */
  eligible?: boolean;
  unavailableText?: string;
  testId?: string;
}) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <dt className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide uppercase">
        {label}
        {eligible !== undefined ? (
          <EligibilityBadge eligible={eligible} />
        ) : null}
      </dt>
      <dd className="min-w-0 break-words">
        {value ? (
          arabic ? (
            <ArabicText className="text-xl">{value}</ArabicText>
          ) : (
            <span className="text-base">{value}</span>
          )
        ) : (
          <span className="text-muted-foreground text-sm italic">
            {unavailableText}
          </span>
        )}
      </dd>
    </div>
  );
}
