import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setTheme = vi.fn();
const themeState = { theme: "system" as string | undefined };

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeState.theme, setTheme }),
}));

import { ThemeSelector } from "@/components/settings/theme-selector";

describe("ThemeSelector", () => {
  beforeEach(() => {
    setTheme.mockClear();
    themeState.theme = "system";
  });

  it("has an accessible group name and named options", () => {
    render(<ThemeSelector />);
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
    for (const name of ["System", "Light", "Dark"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("represents the current theme via aria-pressed", () => {
    themeState.theme = "dark";
    render(<ThemeSelector />);
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it.each([
    ["Light", "light"],
    ["Dark", "dark"],
    ["System", "system"],
  ])("selecting %s calls setTheme with %s", async (label, value) => {
    const user = userEvent.setup();
    render(<ThemeSelector />);
    await user.click(screen.getByRole("button", { name: label }));
    expect(setTheme).toHaveBeenCalledWith(value);
  });
});
