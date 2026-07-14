import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DashboardPage from "@/app/(shell)/page";

describe("DashboardPage", () => {
  it("renders the Dashboard heading as the top-level heading", () => {
    render(<DashboardPage />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Dashboard");
  });

  it("renders placeholder content without fake statistics", () => {
    render(<DashboardPage />);
    expect(
      screen.getByText(/progress, streaks and due reviews arrive/i),
    ).toBeInTheDocument();
  });
});
