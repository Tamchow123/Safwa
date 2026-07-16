import { expect, test as base } from "@playwright/test";

/**
 * Test base that fails on any console error or uncaught page error —
 * this is how hydration problems and runtime errors surface in E2E.
 *
 * Strict by default: a missing font, script, stylesheet or content
 * artifact fails the test. Tests that deliberately go offline opt in with
 * `test.use({ allowExpectedNetworkErrors: true })`, which permits
 * network/resource-load failures ONLY — hydration and runtime errors are
 * always caught.
 */
type ConsoleGuardOptions = {
  allowExpectedNetworkErrors: boolean;
};

const NETWORK_ERROR_PATTERNS = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /fetch failed/i,
];

export const test = base.extend<ConsoleGuardOptions & { consoleGuard: void }>({
  allowExpectedNetworkErrors: [false, { option: true }],
  consoleGuard: [
    async ({ page, allowExpectedNetworkErrors }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (
          allowExpectedNetworkErrors &&
          NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(text))
        ) {
          return;
        }
        errors.push(text);
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
