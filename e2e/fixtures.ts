import { expect, test as base } from "@playwright/test";

/**
 * Test base that fails on any console error or uncaught page error —
 * this is how hydration problems and runtime errors surface in E2E.
 *
 * Resource-load failures are excluded: offline-fallback tests disconnect
 * the network on purpose, and the browser logs those fetch failures as
 * console errors. Hydration/runtime errors have distinct messages and are
 * still caught.
 */
const IGNORED_PATTERNS = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /fetch failed/i,
];

export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          !IGNORED_PATTERNS.some((pattern) => pattern.test(message.text()))
        ) {
          errors.push(message.text());
        }
      });
      page.on("pageerror", (error) => {
        errors.push(String(error));
      });
      await use();
      expect(errors, "console/page errors during test").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
