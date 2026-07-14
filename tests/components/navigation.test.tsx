import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathnameState = { pathname: "/" };

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.pathname,
}));

import { AppSidebar } from "@/components/navigation/app-sidebar";
import { MobileNav } from "@/components/navigation/mobile-nav";
import { isActiveRoute, NAV_ITEMS } from "@/components/navigation/nav-items";

function linkHrefs(container: HTMLElement): (string | null)[] {
  return within(container)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));
}

describe("isActiveRoute", () => {
  it("matches the dashboard route exactly", () => {
    expect(isActiveRoute("/", "/")).toBe(true);
    expect(isActiveRoute("/library", "/")).toBe(false);
  });

  it("matches nested routes of a section", () => {
    expect(isActiveRoute("/library", "/library")).toBe(true);
    expect(isActiveRoute("/library/42", "/library")).toBe(true);
    expect(isActiveRoute("/librarian", "/library")).toBe(false);
  });
});

describe("navigation", () => {
  beforeEach(() => {
    pathnameState.pathname = "/library";
  });

  it("desktop and mobile navigation use the same route definitions", () => {
    const sidebar = render(<AppSidebar />).container;
    const mobile = render(<MobileNav />).container;
    const expected = NAV_ITEMS.map((item) => item.href);
    expect(linkHrefs(sidebar)).toEqual(expected);
    expect(linkHrefs(mobile)).toEqual(expected);
  });

  it("marks the active item with aria-current=page in both navs", () => {
    render(<AppSidebar />);
    render(<MobileNav />);
    const activeLinks = screen.getAllByRole("link", { current: "page" });
    expect(activeLinks).toHaveLength(2);
    for (const link of activeLinks) {
      expect(link).toHaveAttribute("href", "/library");
    }
  });

  it("shows the Safwa name in the desktop sidebar", () => {
    render(<AppSidebar />);
    expect(screen.getByText("Safwa")).toBeInTheDocument();
  });
});
