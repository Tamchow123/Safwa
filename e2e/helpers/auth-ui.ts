import type { Locator, Page } from "@playwright/test";

/**
 * The auth forms' own error message, distinguished from Next.js's
 * `#__next-route-announcer__` div (which also carries `role="alert"` for
 * screen-reader route-change announcements and would otherwise collide
 * with a plain `page.getByRole("alert")` query in a strict-mode failure).
 * Every auth form renders its error as `<p role="alert">` (see
 * use-auth-form-submit.ts's callers) — scoping to the tag name is what
 * actually disambiguates the two.
 */
export function errorAlert(page: Page): Locator {
  return page.locator('p[role="alert"]');
}
