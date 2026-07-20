import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BookmarkToggle } from "@/components/collections/bookmark-toggle";

describe("BookmarkToggle", () => {
  it("shows the unsaved state with an accessible save label", () => {
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: 'Save "to preserve"',
    });
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the saved state with an accessible remove label", () => {
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={true}
        onToggle={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: 'Remove "to preserve" from bookmarks',
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("has at least an approximately 44x44px target", () => {
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={vi.fn()}
      />,
    );
    const button = screen.getByTestId("bookmark-toggle");
    expect(button.className).toMatch(/min-h-11/);
    expect(button.className).toMatch(/min-w-11/);
  });

  it("optimistically flips state on click and calls onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={onToggle}
      />,
    );
    const button = screen.getByTestId("bookmark-toggle");
    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows a pending state while the write is in flight", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onToggle = vi.fn().mockReturnValue(gate);
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={onToggle}
      />,
    );
    const button = screen.getByTestId("bookmark-toggle");
    await user.click(button);
    expect(button).toHaveAttribute("data-pending", "true");
    expect(button).toBeDisabled();
    release();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("restores the previous visible state and shows an error on a failed write", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn().mockRejectedValue(new Error("boom"));
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={onToggle}
      />,
    );
    const button = screen.getByTestId("bookmark-toggle");
    await user.click(button);
    await waitFor(() =>
      expect(button).toHaveAttribute("aria-pressed", "false"),
    );
    expect(
      screen.getByText(
        "Couldn't update your saved vocabulary. Please try again.",
      ),
    ).toBeInTheDocument();
  });

  it("recovers even when onToggle throws synchronously instead of rejecting", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn(() => {
      throw new Error("synchronous boom");
    });
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={onToggle as unknown as () => Promise<void>}
      />,
    );
    const button = screen.getByTestId("bookmark-toggle");
    await user.click(button);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText(
        "Couldn't update your saved vocabulary. Please try again.",
      ),
    ).toBeInTheDocument();
  });

  it("never exposes the raw entry id as the only accessible label", () => {
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={vi.fn()}
      />,
    );
    const button = screen.getByTestId("bookmark-toggle");
    expect(button.getAttribute("aria-label")).not.toMatch(/^\d+$/);
  });

  it("two clicks dispatched in the same tick (a genuine double-click) start only one write", async () => {
    // Two React state updates from the first click have not yet flushed
    // (and so `disabled` has not yet reached the DOM) when the second click
    // fires — this is exactly the race the synchronous ref guard defends
    // against, independent of userEvent's own disabled-element skipping.
    let resolveCount = 0;
    const onToggle = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolveCount += 1;
            resolve();
          }, 20);
        }),
    );
    render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={onToggle}
      />,
    );
    const button = screen.getByTestId("bookmark-toggle");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(resolveCount).toBe(1));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("collapses back to the authoritative prop once it catches up", () => {
    const { rerender } = render(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={false}
        onToggle={vi.fn()}
      />,
    );
    rerender(
      <BookmarkToggle
        entryLabel="to preserve"
        bookmarked={true}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId("bookmark-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
