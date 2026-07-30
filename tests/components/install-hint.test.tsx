import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallHint } from "@/components/pwa/install-hint";
import { INSTALL_HINT_DISMISSED_KEY } from "@/modules/pwa/install-hint";

/**
 * The wiring, not the decisions — those are `modules/pwa/install-hint.test.ts`.
 *
 * What can only be proved here is that the component asks the browser the right
 * questions and reacts to an event that arrives long after render:
 * `beforeInstallPrompt` is fired by Chromium whenever it decides the app is
 * installable, which is routinely after load, so a component that only looked
 * at the world once during mount would show nothing on the platform that has a
 * real install flow.
 */
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PIXEL =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function setNavigator(userAgent: string, maxTouchPoints: number): void {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
}

/** jsdom implements no `matchMedia` at all. */
function setDisplayModeStandalone(standalone: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      matches: standalone && query.includes("standalone"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    configurable: true,
  });
}

/**
 * The Chromium event, as the browser delivers it.
 *
 * Dispatched inside `act` because it lands on a `window` listener rather than
 * on a rendered element, so Testing Library has no `fireEvent` wrapper to
 * provide the boundary — and the listener sets state.
 */
function fireBeforeInstallPrompt(prompt: () => Promise<void>): Event {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, { prompt });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  window.localStorage.clear();
  setDisplayModeStandalone(false);
  setNavigator(PIXEL, 5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the install hint", () => {
  it("renders nothing before the browser says anything", () => {
    // A Chromium UA that has not yet been told the app is installable. The
    // matching server case is the store's `getServerSnapshot`, which returns
    // "none" unconditionally — every input here (user agent, display mode,
    // localStorage, an event that has not fired) exists only in a browser, so
    // a prerender that guessed at any of them would be a hydration mismatch on
    // the ~20 static routes this app ships.
    const { container } = render(<InstallHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a real install button once Chromium fires its event", async () => {
    render(<InstallHint />);
    fireBeforeInstallPrompt(async () => {});

    const button = await screen.findByRole("button", { name: "Install" });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText(/Add to Home Screen/)).not.toBeInTheDocument();
  });

  it("suppresses the browser's own infobar so it owns the timing", async () => {
    render(<InstallHint />);
    const event = fireBeforeInstallPrompt(async () => {});
    await screen.findByRole("button", { name: "Install" });
    expect(event.defaultPrevented).toBe(true);
  });

  it("triggers the browser's flow and closes the offer", async () => {
    const prompt = vi.fn(async () => {});
    render(<InstallHint />);
    fireBeforeInstallPrompt(prompt);

    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    // Closed either way. A learner who has just dismissed the browser's own
    // dialog does not want the same suggestion still sitting there, and the
    // event can only be used once.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Install" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("survives a prompt the browser refuses to replay", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("already used");
    });
    render(<InstallHint />);
    fireBeforeInstallPrompt(prompt);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    // No unhandled rejection, and the card is gone rather than stuck.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Install" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the Share gesture on iOS, where no event will ever fire", async () => {
    // The reason this platform gets a different answer rather than a degraded
    // version of the same one: WebKit implements no beforeinstallprompt at all,
    // so there is nothing to wait for and nothing to trigger.
    setNavigator(IPHONE, 5);
    render(<InstallHint />);
    expect(await screen.findByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Install" }),
    ).not.toBeInTheDocument();
  });

  it("says nothing at all inside the installed app", async () => {
    setNavigator(IPHONE, 5);
    setDisplayModeStandalone(true);
    const { container } = render(<InstallHint />);
    // Deliberately asserted after an event that WOULD otherwise raise a hint,
    // so this proves suppression rather than merely a slow start.
    fireBeforeInstallPrompt(async () => {});
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("remembers a dismissal", async () => {
    render(<InstallHint />);
    fireBeforeInstallPrompt(async () => {});
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Dismiss install suggestion",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Install" }),
      ).not.toBeInTheDocument(),
    );
    expect(window.localStorage.getItem(INSTALL_HINT_DISMISSED_KEY)).toBe(
      "true",
    );
  });

  it("stays dismissed even when the install event arrives afterwards", async () => {
    // The ordering that matters: Chromium can fire its event well after load,
    // so a dismissal that was only checked at mount would be undone by it.
    window.localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, "true");
    const { container } = render(<InstallHint />);
    fireBeforeInstallPrompt(async () => {});
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("closes itself when the install completes by any other route", async () => {
    // The browser's own menu installs without going through this component.
    render(<InstallHint />);
    fireBeforeInstallPrompt(async () => {});
    await screen.findByRole("button", { name: "Install" });
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Install" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("gives the dismiss control a 44px hit area", async () => {
    // §8's requirement, and specifically via padding: the icon itself is
    // unchanged, so nothing looks different — it is simply reliably hittable.
    render(<InstallHint />);
    fireBeforeInstallPrompt(async () => {});
    const dismiss = await screen.findByRole("button", {
      name: "Dismiss install suggestion",
    });
    expect(dismiss.className).toContain("min-h-11");
    expect(dismiss.className).toContain("min-w-11");
  });
});
