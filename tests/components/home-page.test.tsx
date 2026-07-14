import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "@/app/page";
import { siteConfig } from "@/lib/site";

describe("HomePage", () => {
  it("renders the Safwa heading as the top-level heading", () => {
    render(<HomePage />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(siteConfig.name);
  });

  it("renders the tagline", () => {
    render(<HomePage />);
    expect(screen.getByText(siteConfig.tagline)).toBeVisible();
  });
});
