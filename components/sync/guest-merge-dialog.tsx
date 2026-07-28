"use client";

/**
 * Phase 17 §19, §21, §25 — the merge prompt, its progress, and its summary.
 *
 * ONE dialog for the whole flow rather than three. The learner is answering a
 * single question — "should this device's history go onto my account?" — and
 * splitting the answer across separate surfaces is how a progress state ends up
 * orphaned from the consent that started it, or a summary appears with no
 * memory of what was asked.
 *
 * Every string comes from `guest-merge-copy.ts`, which is pure and tested:
 * that is what keeps §21's "no raw internal identifiers" checkable rather than
 * merely intended. This file decides only where words go, never what they say.
 *
 * ACCESSIBILITY (§19, §25). The dialog is Radix's, so the modal semantics,
 * focus trap, restore-on-close and Escape handling are the same ones the rest of
 * the app uses. On top of that:
 *  - the dialog is NOT dismissible while a merge is running — closing it would
 *    suggest the merge stopped, which is untrue and unrecoverable-looking;
 *  - progress and outcome are announced through a live region whose urgency
 *    follows the state (polite while working, assertive when stopped);
 *  - the counts are a description list, so a screen reader reads label/value
 *    pairs rather than a run-on line;
 *  - nothing animates beyond the shared dialog transition, which already honours
 *    `prefers-reduced-motion`;
 *  - the layout is a single column with wrapping count rows, so it holds at
 *    320px without horizontal scroll.
 */
import {
  useGuestMerge,
  type GuestMergeContextValue,
} from "@/components/sync/guest-merge-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { guestMergeCopy } from "@/modules/sync/client/guest-merge-copy";

/**
 * Which action the primary button performs, decided from the flow rather than
 * from a chain of ternaries at the call site.
 *
 * There is no "disabled while active" branch because there is no button while
 * active: every running state has `primaryLabel: null`, so the control is
 * absent rather than present-and-disabled. An earlier version also passed
 * `disabled={merge.active}`, which was unreachable — and the test that claimed
 * to cover it looped over an empty button list and asserted nothing (REL-004).
 */
function primaryAction(merge: GuestMergeContextValue): () => void {
  switch (merge.state.flow.name) {
    case "ready-for-consent":
      return merge.consent;
    case "retryable-error":
      return merge.retry;
    default:
      return merge.dismiss;
  }
}

/**
 * The merge dialog. Renders nothing at all unless there is something to say —
 * a guest with no data, a signed-out learner, or a session still resolving all
 * produce empty copy, and an empty title is the single signal for "say nothing"
 * rather than a second predicate this component could forget to check.
 */
export function GuestMergeDialog() {
  const merge = useGuestMerge();
  // Outside a provider (a component rendered in isolation) there is nothing to
  // show — the same non-throwing degradation the sync indicator has.
  if (!merge) return null;

  const copy = guestMergeCopy(merge.state);
  if (copy.title === "") return null;
  // A finished merge the learner has closed. The merge is unchanged; only its
  // surface is gone, until a later flow transition brings one back.
  if (!merge.visible) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Only a dismissible state may be closed, and closing the consent
        // prompt IS "Not now" — a learner who presses Escape has declined, not
        // agreed, and must get the non-destructive answer either way (§9.1).
        if (next || !copy.dismissible) return;
        // Closing the CONSENT prompt is "Not now"; closing a finished one is
        // just closing it. Both are non-destructive, and neither is agreement.
        if (merge.state.flow.name === "ready-for-consent") merge.defer();
        else merge.dismiss();
      }}
    >
      <DialogContent
        showCloseButton={copy.dismissible}
        className="max-w-md"
        data-testid="guest-merge-dialog"
        // The flow's own name, so the E2E suite can wait for a STATE rather
        // than for a sentence. Asserting on prose would make every copy edit a
        // test failure, and worse, would let a test pass because two different
        // states happen to share a word.
        data-flow={merge.state.flow.name}
        // A merge in progress is not dismissible: closing would imply it
        // stopped. Radix's own escape/outside-click paths are refused here so
        // the guarantee does not depend on the close button being hidden.
        onEscapeKeyDown={(event) => {
          if (!copy.dismissible) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!copy.dismissible) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>

        {/*
          The live region is always present and always the same node, so a
          screen reader announces CHANGES to it. Mounting it only when there is
          something to announce would make each announcement a new node, which
          many screen readers do not read at all.
        */}
        <p
          aria-live={copy.liveness === "off" ? "polite" : copy.liveness}
          aria-atomic="true"
          className="sr-only"
        >
          {copy.liveness === "off" ? "" : `${copy.title}. ${copy.body}`}
        </p>

        {copy.counts.length > 0 && (
          <dl className="grid gap-1 text-sm">
            {copy.counts.map((line) => (
              <div
                key={line.label}
                className="flex flex-wrap items-baseline justify-between gap-x-4"
              >
                <dt className="text-muted-foreground">{line.label}</dt>
                <dd className="font-medium tabular-nums">{line.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <DialogFooter>
          {/*
            "Not now" appears only where deferring means something: before
            anything is sent. After that the merge is either running (nothing to
            defer) or over (nothing to defer to).
          */}
          {merge.state.flow.name === "ready-for-consent" && (
            <Button variant="outline" onClick={merge.defer}>
              Not now
            </Button>
          )}
          {copy.primaryLabel !== null && (
            <Button onClick={primaryAction(merge)}>{copy.primaryLabel}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
