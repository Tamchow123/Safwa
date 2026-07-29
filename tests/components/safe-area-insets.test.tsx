import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * What `viewportFit: "cover"` exposed, and how each edge-flush surface answers
 * it.
 *
 * Phase 18 (app/layout.tsx) extends the viewport to the physical glass. That is
 * the point — it is what finally makes `env(safe-area-inset-bottom)` non-zero
 * for the mobile tab bar, which had carried inert safe-area padding since the
 * shell was built. But it applies to every edge and every route, so anything
 * else drawn flush to an edge inherits the same exposure: a bottom-anchored
 * toast, the sticky header's right-aligned controls, the sidebar's left edge.
 *
 * These tests pin the DECLARATIONS, not rendered geometry. jsdom has no safe
 * areas and no viewport worth measuring, so asserting pixel positions here
 * would prove nothing; asserting that the inset is referenced at all is what
 * survives a future restyle deleting it by accident. Real-device confirmation
 * is a manual step of this phase's deployment drill, not something a headless
 * browser can simulate — Playwright cannot set `env()` values either.
 */
const sonnerProps = vi.fn();
vi.mock("sonner", () => ({
  Toaster: (props: Record<string, unknown>) => {
    sonnerProps(props);
    return null;
  },
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light" }) }));

// The header's children reach for auth, sync and theme context that has
// nothing to do with padding; stub them so this stays a layout test.
vi.mock("@/components/auth/account-menu", () => ({
  AccountMenu: () => null,
}));
vi.mock("@/components/sync/sync-status-indicator", () => ({
  SyncStatusIndicator: () => null,
}));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/navigation/app-sidebar";
import { Toaster } from "@/components/ui/sonner";

function renderToaster(): Record<string, unknown> {
  sonnerProps.mockClear();
  render(<Toaster />);
  return sonnerProps.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("Toaster offsets under viewport-fit: cover", () => {
  it("keeps a mobile toast clear of the home indicator", () => {
    const props = renderToaster();
    const offset = props.mobileOffset as { bottom: string };
    expect(offset.bottom).toContain("env(safe-area-inset-bottom)");
  });

  it("also clears the 56px mobile tab bar, which is fixed to the same edge", () => {
    // Not just the inset: components/navigation/mobile-nav.tsx occupies the
    // bottom edge on the same breakpoint, so an inset-only offset would put
    // the toast behind the tab bar instead of behind the home indicator.
    const props = renderToaster();
    const offset = props.mobileOffset as { bottom: string };
    const remMatch = /\+\s*([\d.]+)rem/.exec(offset.bottom);
    expect(remMatch, `no rem term in "${offset.bottom}"`).not.toBeNull();
    expect(Number(remMatch?.[1])).toBeGreaterThanOrEqual(3.5);
  });

  it("applies the inset on desktop too, where it simply resolves to zero", () => {
    const props = renderToaster();
    const offset = props.offset as { bottom: string };
    expect(offset.bottom).toContain("env(safe-area-inset-bottom)");
  });

  it("still forwards caller props, so a page can override the position", () => {
    sonnerProps.mockClear();
    render(<Toaster position="top-center" />);
    const props = sonnerProps.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.position).toBe("top-center");
  });
});

describe("AppHeader under viewport-fit: cover", () => {
  function headerClasses(): string {
    const { container } = render(<AppHeader />);
    const header = container.querySelector("header");
    expect(header, "AppHeader must render a <header>").not.toBeNull();
    return header?.className ?? "";
  }

  it("insets its right edge, where the controls are, at every breakpoint", () => {
    // The account menu, sync indicator and theme toggle are all ml-auto. In
    // landscape on a notched phone this is the edge the cutout is on.
    const classes = headerClasses();
    expect(classes).toContain("pr-[calc(1rem_+_env(safe-area-inset-right))]");
    expect(classes).toContain(
      "md:pr-[calc(2rem_+_env(safe-area-inset-right))]",
    );
  });

  it("insets its left edge only until the sidebar takes that edge over", () => {
    const classes = headerClasses();
    expect(classes).toContain("pl-[calc(1rem_+_env(safe-area-inset-left))]");
    // At md the sidebar is flush left and absorbs the inset itself; a second
    // copy here would double-count it.
    expect(classes).toContain("md:pl-8");
    expect(classes).not.toContain("md:pl-[calc");
  });

  it("keeps its ordinary padding when there is no inset to add", () => {
    // env() resolves to 0 on a device without a cutout, so the calc() must
    // still carry the design's own 1rem/2rem or the header loses its padding
    // everywhere rather than gaining it in one place.
    const classes = headerClasses();
    expect(classes).toContain("1rem");
    expect(classes).toContain("2rem");
  });

  it("adds no top inset, because an installed iOS window starts below the status bar", () => {
    // appleWebApp.statusBarStyle is "default" (app/layout.tsx), not
    // "black-translucent" — content is laid out below the status bar, so a top
    // inset would be permanently empty space.
    expect(headerClasses()).not.toContain("safe-area-inset-top");
  });
});

describe("AppSidebar under viewport-fit: cover", () => {
  it("absorbs the left inset for the breakpoint where it owns that edge", () => {
    const { container } = render(<AppSidebar />);
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("pl-[env(safe-area-inset-left)]");
  });
});
