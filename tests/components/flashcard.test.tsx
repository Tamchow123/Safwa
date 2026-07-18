import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Flashcard } from "@/components/flashcard";

function setup(
  overrides: Partial<React.ComponentProps<typeof Flashcard>> = {},
) {
  const onFlip = vi.fn();
  const props: React.ComponentProps<typeof Flashcard> = {
    front: <span>PROMPT</span>,
    back: <span>ANSWER</span>,
    frontCaption: "Arabic form",
    backCaption: "Meaning",
    flipped: false,
    onFlip,
    reducedMotion: false,
    ...overrides,
  };
  render(<Flashcard {...props} />);
  return { onFlip };
}

describe("Flashcard", () => {
  it("is a single button that flips on click", async () => {
    const user = userEvent.setup();
    const { onFlip } = setup();
    const card = screen.getByTestId("flashcard");
    expect(card.tagName).toBe("BUTTON");
    expect(card).toHaveAttribute("data-flipped", "false");
    await user.click(card);
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("flips on Space and Enter (native button semantics)", async () => {
    const user = userEvent.setup();
    const { onFlip } = setup();
    screen.getByTestId("flashcard").focus();
    await user.keyboard(" ");
    await user.keyboard("{Enter}");
    expect(onFlip).toHaveBeenCalledTimes(2);
  });

  it("keeps the answer out of the accessibility tree until flipped (animated)", () => {
    setup({ flipped: false });
    // Both faces exist in the DOM for the 3D flip, but the answer face is
    // aria-hidden while the prompt is showing.
    const answer = screen.getByText("ANSWER");
    expect(answer.closest("[aria-hidden='true']")).not.toBeNull();
    const prompt = screen.getByText("PROMPT");
    expect(prompt.closest("[aria-hidden='true']")).toBeNull();
  });

  it("reveals the answer face and hides the prompt once flipped", () => {
    setup({ flipped: true });
    const card = screen.getByTestId("flashcard");
    expect(card).toHaveAttribute("data-flipped", "true");
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("ANSWER").closest("[aria-hidden='true']"),
    ).toBeNull();
    expect(
      screen.getByText("PROMPT").closest("[aria-hidden='true']"),
    ).not.toBeNull();
  });

  it("reduced-motion variant renders only the visible face (no answer in DOM)", () => {
    setup({ reducedMotion: true, flipped: false });
    const card = screen.getByTestId("flashcard");
    expect(card).toHaveAttribute("data-reduced-motion", "true");
    expect(screen.getByText("PROMPT")).toBeInTheDocument();
    expect(screen.queryByText("ANSWER")).not.toBeInTheDocument();
  });

  it("reduced-motion variant swaps to the answer when flipped", () => {
    setup({ reducedMotion: true, flipped: true });
    expect(screen.getByText("ANSWER")).toBeInTheDocument();
    expect(screen.queryByText("PROMPT")).not.toBeInTheDocument();
  });
});
