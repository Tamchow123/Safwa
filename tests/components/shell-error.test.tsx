/**
 * Shell route-segment error boundary (Phase 12 §18): a render/runtime error
 * degrades to a user-safe recoverable message with a working reset action,
 * and the caught error's internals never reach the learner.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import ShellError from "@/app/(shell)/error";

describe("ShellError", () => {
  it("renders a user-safe recoverable message, never the error internals", () => {
    render(
      <ShellError
        error={new Error("Dexie object store daily_activity is corrupt")}
        reset={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("please try again");
    expect(alert.textContent).not.toContain("Dexie");
    expect(alert.textContent).not.toContain("daily_activity");
  });

  it("the try-again action invokes the boundary reset", async () => {
    const reset = vi.fn();
    render(<ShellError error={new Error("boom")} reset={reset} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
