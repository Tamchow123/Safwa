import { describe, expect, it } from "vitest";

import {
  INSTALL_HINT_DISMISSED_KEY,
  isIosLike,
  isRunningInstalled,
  readInstallHintDismissed,
  resolveInstallHint,
  writeInstallHintDismissed,
  type InstallHintStorage,
} from "@/modules/pwa/install-hint";

/**
 * The install offer's decisions.
 *
 * The one that matters is that iOS gets a different ANSWER rather than a
 * degraded version of the same one: WebKit implements no `beforeinstallprompt`
 * at all, so a page there can only describe the gesture.
 */
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_OS_13_PLUS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const PIXEL =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function memoryStorage(initial?: Record<string, string>): InstallHintStorage & {
  read: (key: string) => string | undefined;
} {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    read: (key) => map.get(key),
  };
}

describe("whether the page is already running as an installed app", () => {
  it("believes the standard display-mode signal", () => {
    expect(
      isRunningInstalled({
        displayModeStandalone: true,
        navigatorStandalone: undefined,
      }),
    ).toBe(true);
  });

  it("believes Safari's non-standard property too", () => {
    // On iOS this is the ONLY signal — the display-mode media query has
    // historically not been reliable for home-screen apps there.
    expect(
      isRunningInstalled({
        displayModeStandalone: false,
        navigatorStandalone: true,
      }),
    ).toBe(true);
  });

  it("does not treat an absent property as installed", () => {
    // The failure that matters: a false positive hides the hint from everyone
    // on a platform, and it cannot be noticed from inside the installed app.
    expect(
      isRunningInstalled({
        displayModeStandalone: false,
        navigatorStandalone: undefined,
      }),
    ).toBe(false);
    expect(
      isRunningInstalled({
        displayModeStandalone: false,
        navigatorStandalone: false,
      }),
    ).toBe(false);
  });
});

describe("recognising iOS, where installing is a manual gesture", () => {
  it("recognises an iPhone", () => {
    expect(isIosLike({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
  });

  it("recognises an iPad, which reports a desktop Macintosh user agent", () => {
    // iPadOS 13+ deliberately claims to be a Mac. Touch points are what still
    // separate them: a real Mac reports none.
    expect(isIosLike({ userAgent: IPAD_OS_13_PLUS, maxTouchPoints: 5 })).toBe(
      true,
    );
  });

  it("does not mistake a real Mac for one", () => {
    expect(isIosLike({ userAgent: IPAD_OS_13_PLUS, maxTouchPoints: 0 })).toBe(
      false,
    );
  });

  it("does not claim an Android phone", () => {
    // Chromium fires beforeinstallprompt here, so this platform must fall
    // through to the real install flow rather than to hand-written wording for
    // a Share menu it does not have.
    expect(isIosLike({ userAgent: PIXEL, maxTouchPoints: 5 })).toBe(false);
  });
});

describe("which hint to show", () => {
  const base = {
    installed: false,
    dismissed: false,
    iosLike: false,
    promptAvailable: false,
  };

  it("offers the real install flow when the browser gave us one", () => {
    expect(resolveInstallHint({ ...base, promptAvailable: true })).toBe(
      "prompt",
    );
  });

  it("falls back to the Share gesture on iOS, where there is no flow", () => {
    expect(resolveInstallHint({ ...base, iosLike: true })).toBe("manual-ios");
  });

  it("says nothing on a browser that offers neither", () => {
    // A desktop Firefox has no install prompt and no Share → Add to Home
    // Screen. Instructions for a gesture that does not exist are worse than
    // silence.
    expect(resolveInstallHint(base)).toBe("none");
  });

  it("says nothing inside the installed app, on either platform", () => {
    expect(
      resolveInstallHint({ ...base, installed: true, promptAvailable: true }),
    ).toBe("none");
    expect(
      resolveInstallHint({ ...base, installed: true, iosLike: true }),
    ).toBe("none");
  });

  it("honours a dismissal over both routes", () => {
    // Dismissal has to outrank the prompt as well as the iOS wording,
    // otherwise a Chromium user who dismissed the card gets it straight back
    // the moment beforeinstallprompt fires — which can be long after load.
    expect(
      resolveInstallHint({ ...base, dismissed: true, promptAvailable: true }),
    ).toBe("none");
    expect(
      resolveInstallHint({ ...base, dismissed: true, iosLike: true }),
    ).toBe("none");
  });
});

describe("remembering a dismissal", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    expect(readInstallHintDismissed(storage)).toBe(false);
    writeInstallHintDismissed(storage);
    expect(storage.read(INSTALL_HINT_DISMISSED_KEY)).toBe("true");
    expect(readInstallHintDismissed(storage)).toBe(true);
  });

  it("versions the key, so a future format is a new key not a parser", () => {
    expect(INSTALL_HINT_DISMISSED_KEY).toMatch(/^safwa\..*\.v1$/);
  });

  it("treats an unreadable store as not dismissed", () => {
    // Degrading to "show it again" rather than "hide it forever": an
    // unreadable dismissal is not evidence of a dismissal.
    const throwing: InstallHintStorage = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {},
    };
    expect(readInstallHintDismissed(throwing)).toBe(false);
    expect(readInstallHintDismissed(null)).toBe(false);
  });

  it("swallows a failed write", () => {
    // Safari private mode throws on setItem. The card closes either way; it
    // simply returns next visit.
    const throwing: InstallHintStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writeInstallHintDismissed(throwing)).not.toThrow();
    expect(() => writeInstallHintDismissed(null)).not.toThrow();
  });
});
