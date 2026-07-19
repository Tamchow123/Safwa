/**
 * Shared axe assertion for specs that gate on SERIOUS/CRITICAL violations
 * (a11y.spec.ts, dashboard.spec.ts). Specs asserting the stricter
 * zero-violations contract (mc-quiz, bab-root-mixed) keep their own local
 * helpers deliberately — the contracts differ.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

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
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}
