/**
 * Concise, supportive explanation of how weakness is measured (Phase 13
 * §16): recent first attempts, review lapses and recency drive the score;
 * reinforcement recovery does not erase the initial difficulty; the ranking
 * changes as the learner studies; untouched content is never weak. Kept
 * short in the main UI, with the fuller detail behind a native disclosure.
 */
export function WeaknessExplanation() {
  return (
    <div className="text-muted-foreground space-y-2 text-sm">
      <p>
        This page highlights areas that could use more practice, based on your
        recent first attempts, review lapses and how recently you struggled.
      </p>
      <details>
        <summary className="text-foreground w-fit cursor-pointer select-none">
          How is this worked out?
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Weakness is based on recent first attempts, review lapses and
            recency — not your whole history.
          </li>
          <li>Reinforcement recoveries do not erase the initial difficulty.</li>
          <li>The ranking changes as you keep studying.</li>
          <li>
            Content you haven&apos;t studied yet is never treated as weak.
          </li>
        </ul>
      </details>
    </div>
  );
}
