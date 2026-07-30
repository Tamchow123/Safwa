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
 *
 * Two channels, and they are NOT filtered identically (Phase 18). Console
 * messages may be excused by either list below; uncaught page errors only by
 * `BROWSER_NETWORK_ERROR_PATTERNS`, because network-shaped text the app itself
 * throws must still fail a test. Read the comment on each list before adding to
 * either — a pattern that is safe on one channel is not automatically safe on
 * the other.
 */
type ConsoleGuardOptions = {
  allowExpectedNetworkErrors: boolean;
};

/**
 * Messages the BROWSER emits for a resource load that failed or was cancelled.
 *
 * Tolerated on both channels when a spec opts in. Each entry is a group: a
 * message must match **every** pattern in its group, which is how the WebKit
 * entry below stays narrow without depending on what sits between its two
 * halves.
 */
const BROWSER_NETWORK_ERROR_PATTERNS: RegExp[][] = [
  [/Failed to load resource/i],
  [/net::ERR_/i],
  // WebKit's wording, added in Phase 18 when the offline config brought a second
  // engine into this suite (playwright.offline.config.ts). WebKit reports a
  // resource load that was CANCELLED — an RSC prefetch still in flight when the
  // page navigates away — as "Fetch API cannot load <url> due to access control
  // checks", which nothing above matches. Measured: with a service worker in
  // control those cancellations go from one to five per journey, because the
  // worker's own fetches are cancelled alongside the page's; Chromium logs no
  // console error for them at all.
  //
  // Both halves are required rather than just the distinctive tail, so an app
  // error that merely mentions access control cannot be swallowed. They are two
  // patterns rather than one because the URL WebKit interpolates in the middle
  // can carry whitespace, and a `cannot load .* due to` pattern therefore misses
  // the very message it was written for.
  //
  // The residual trade-off, stated because it is real: WebKit uses this same
  // wording for a genuine cross-origin denial, so a spec that opts in gives up
  // the ability to catch one. Accepted because the app makes no cross-origin
  // request at all today. A spec that needs to assert CORS behaviour must not
  // opt in.
  [/Fetch API cannot load/i, /due to access control checks/i],
];

/**
 * Network-shaped text that the APP itself can throw, tolerated only where it
 * always was — a console message, never an uncaught error.
 *
 * `/fetch failed/i` cannot be applied to the `pageerror` channel, and the reason
 * is concrete rather than precautionary: `modules/content/load.ts` throws
 * `active pointer fetch failed: HTTP <status>` and `learner fetch failed: HTTP
 * <status>`, both of which match it. Those are exactly the failures
 * `content-foundation.spec.ts` exercises, and that spec opts in — so filtering
 * the uncaught-error channel with this pattern would hide a real content-loading
 * defect in the one suite most likely to produce it.
 */
const CONSOLE_ONLY_NETWORK_ERROR_PATTERNS: RegExp[][] = [[/fetch failed/i]];

const matchesAnyGroup = (groups: RegExp[][], text: string): boolean =>
  groups.some((group) => group.every((pattern) => pattern.test(text)));

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
          (matchesAnyGroup(BROWSER_NETWORK_ERROR_PATTERNS, text) ||
            matchesAnyGroup(CONSOLE_ONLY_NETWORK_ERROR_PATTERNS, text))
        ) {
          return;
        }
        errors.push(text);
      });

      // Tagged, and filtered — but by the BROWSER patterns only.
      //
      // Both halves of that were learned the hard way in Phase 18. WebKit
      // surfaces a cancelled `fetch` as an uncaught rejection on THIS channel
      // rather than as a console error, so an allow-list applied only to console
      // messages let a network event through while reporting text identical to
      // one it had just tolerated — as confusing a failure as this suite has
      // produced. The tag is what tells the two channels apart at a glance.
      //
      // Filtering here narrows the guard, so it is kept to the messages the
      // browser itself emits: an app-thrown error can still fail a test even in
      // a spec that opted in, which is what keeps
      // `CONSOLE_ONLY_NETWORK_ERROR_PATTERNS` off this channel.
      page.on("pageerror", (error) => {
        const text = String(error);
        if (
          allowExpectedNetworkErrors &&
          matchesAnyGroup(BROWSER_NETWORK_ERROR_PATTERNS, text)
        ) {
          return;
        }
        errors.push(`[pageerror] ${text}`);
      });
      await use();
      // The flag is named in the message because "which errors are tolerated"
      // is the first thing anyone reading this failure needs to know, and it is
      // set per describe-block rather than per file.
      expect(
        errors,
        `console/page errors during test (allowExpectedNetworkErrors=${allowExpectedNetworkErrors}) ${JSON.stringify(errors[0] ?? null)}`,
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
