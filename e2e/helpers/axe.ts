/**
 * Shared axe assertion for specs that gate on SERIOUS/CRITICAL violations
 * (a11y.spec.ts, dashboard.spec.ts). Specs asserting the stricter
 * zero-violations contract (mc-quiz, bab-root-mixed) keep their own local
 * helpers deliberately — the contracts differ.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Wait until `locator` and everything under it has finished animating.
 *
 * Needed before scanning anything that fades or zooms in — the shared dialog
 * enters with `fade-in-0 zoom-in-95`, and axe's colour-contrast check evaluates
 * whatever opacity it finds at that instant, so a scan fired the moment a
 * dialog opens reports a SERIOUS contrast violation for a button that is
 * perfectly legible a frame later. Waiting for the animations is the honest fix;
 * relaxing the contrast rule would be hiding a real check to silence a fake
 * failure. Rejected animations settle rather than throw — an interrupted one
 * means the element moved on, not that the wait failed.
 */
export async function settleAnimations(locator: Locator) {
  await locator.evaluate(async (element) => {
    await Promise.allSettled(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
}

/** Fail on serious/critical axe violations; report everything found. */
export async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    serious.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target.join(" "),
        // The measured values, not just the selector. A bare selector tells
        // you WHERE axe objected and nothing about why, which turns every
        // contrast failure into a manual re-derivation of numbers axe already
        // computed.
        why: node.any.map((check) => check.message).join("; "),
      })),
    })),
  ).toEqual([]);
}
