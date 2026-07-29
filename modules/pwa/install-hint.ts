/**
 * Whether, and how, to offer installing the app (Phase 18, slice 11).
 *
 * Pure — `components/pwa/install-hint.tsx` renders what this returns and
 * decides nothing itself. The interesting part is not the rendering; it is that
 * the two platforms this app targets offer installation through two entirely
 * different mechanisms, and only one of them tells the page anything.
 */

/** Where the dismissal is remembered. Versioned in the key (see below). */
export const INSTALL_HINT_DISMISSED_KEY = "safwa.install-hint-dismissed.v1";

/** The narrow slice of the Storage API this module uses. */
export type InstallHintStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * What to show.
 *
 * - `prompt` — the browser fired `beforeinstallprompt`, so there is a real
 *   install flow to trigger and a button that means something.
 * - `manual-ios` — iOS has no `beforeinstallprompt` at all, in any browser: the
 *   engine is WebKit everywhere and WebKit does not implement it. The app is
 *   still installable, but only through Share → Add to Home Screen, which the
 *   page cannot trigger and can only describe.
 * - `none` — already installed, dismissed, or a browser that will not install
 *   anything. Showing an install hint to someone reading this inside the
 *   installed app is the one outcome worth actively avoiding.
 */
export type InstallHint = "prompt" | "manual-ios" | "none";

/**
 * Is this page running inside the installed app rather than a browser tab?
 *
 * Two signals because the platforms disagree. `display-mode: standalone`
 * is the standard one and is what Chromium answers to; `navigator.standalone`
 * is a non-standard Safari property that is the ONLY signal on iOS, where the
 * media query has historically been unreliable for home-screen apps.
 *
 * Either being true is enough. A false negative here shows an install hint to
 * someone who has already installed — mildly silly. A false positive hides the
 * hint from everyone on that platform, which is the failure that cannot be
 * noticed from inside the installed app.
 */
export function isRunningInstalled(input: {
  displayModeStandalone: boolean;
  navigatorStandalone: boolean | undefined;
}): boolean {
  return input.displayModeStandalone || input.navigatorStandalone === true;
}

/**
 * Is this iOS (or iPadOS), where installation is a manual gesture?
 *
 * User-agent sniffing, which is normally the wrong tool — but the thing being
 * detected genuinely is the platform, and there is no feature to test for: the
 * whole point is the ABSENCE of `beforeinstallprompt`, and absence is
 * indistinguishable from "it has not fired yet".
 *
 * iPadOS 13+ reports a desktop Macintosh user agent, so an iPad is recognised
 * by a Mac-like UA that also reports touch points — a real Mac reports none.
 * Getting this wrong in either direction is cheap: a Mac shown iOS wording sees
 * instructions for a menu it does not have, and an iPad shown nothing loses a
 * hint it could have used.
 */
export function isIosLike(input: {
  userAgent: string;
  maxTouchPoints: number;
}): boolean {
  if (/iPad|iPhone|iPod/.test(input.userAgent)) return true;
  return input.userAgent.includes("Macintosh") && input.maxTouchPoints > 1;
}

/** The hint to show, from everything known about the page. */
export function resolveInstallHint(input: {
  installed: boolean;
  dismissed: boolean;
  iosLike: boolean;
  promptAvailable: boolean;
}): InstallHint {
  if (input.installed || input.dismissed) return "none";
  if (input.promptAvailable) return "prompt";
  return input.iosLike ? "manual-ios" : "none";
}

/**
 * Whether the hint was dismissed.
 *
 * Total, like `last-known-owner.ts`'s reads and for the same reasons: the
 * property access itself throws in a storage-blocked context, and none of this
 * exists during the prerender of the ~20 static routes this app ships. An
 * unreadable dismissal degrades to "not dismissed", which shows a hint again
 * rather than hiding one forever.
 */
export function readInstallHintDismissed(
  storage: InstallHintStorage | null,
): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(INSTALL_HINT_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Remember a dismissal. Failing to remember is not worth an error path. */
export function writeInstallHintDismissed(
  storage: InstallHintStorage | null,
): void {
  if (storage === null) return;
  try {
    storage.setItem(INSTALL_HINT_DISMISSED_KEY, "true");
  } catch {
    // A private window that cannot persist this will show the hint again next
    // visit. That is the correct degradation for a dismissable suggestion.
  }
}
