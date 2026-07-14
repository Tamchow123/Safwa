import { expect, test as base } from "@playwright/test";

/**
 * Test base that fails on any console error or uncaught page error —
 * this is how hydration problems and runtime errors surface in E2E.
 */
export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
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
